require("dotenv").config();
const express = require("express");
const path = require("path");
const mailbox = require("./mailbox");
const ai = require("./ai");
const mailer = require("./mailer");
const settingsStore = require("./settings");
const classifications = require("./classifications");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuten — houdt AI-kosten laag
// De lichte envelope-lijst (uid/van/onderwerp/datum) wordt apart en iets korter
// gecachet dan het volledige, beoordeelde resultaat — zo kan de achtergrond-scan
// (zie "scanning" hieronder) telkens een nieuwe portie verwerken zonder dat
// daarvoor de hele mailbox opnieuw bij de IMAP-server moet worden opgevraagd.
const ENVELOPE_CACHE_TTL_MS = 60 * 1000;
let envelopeCache = { at: 0, mails: [], total: 0, capped: false };
// Hoeveel nog-niet-beoordeelde mails we per keer laten scannen. Alle mails
// worden uiteindelijk beoordeeld — dat gebeurt in porties (zie "scanning"
// hieronder) zodat één aanvraag niet vastloopt bij een grote achterstand, en
// het resultaat blijft permanent bewaard zodat een mail maar één keer gescand
// moet worden.
const SCAN_BATCH_SIZE = 40;
let cache = { at: 0, mails: [], total: 0, capped: false, scanned: 0, scanning: false };
const suggestionCache = new Map(); // uid -> voorstel, leegt mee met de mail-cache

async function getLightMails(forceRefresh) {
  const fresh = !forceRefresh && Date.now() - envelopeCache.at < ENVELOPE_CACHE_TTL_MS && envelopeCache.mails.length > 0;
  if (fresh) return { configured: true, ...envelopeCache };

  const data = await mailbox.fetchAllMails();
  if (data.configured) {
    envelopeCache = { at: Date.now(), mails: data.mails, total: data.total, capped: data.capped };
  }
  return data;
}

async function getMails(forceRefresh) {
  const fresh = !forceRefresh && Date.now() - cache.at < CACHE_TTL_MS && cache.mails.length > 0 && !cache.scanning;
  if (fresh) return cache;

  const { configured, mails: light, total, capped } = await getLightMails(forceRefresh);
  if (!configured) {
    cache = { at: Date.now(), mails: [], total: 0, capped: false, scanned: 0, scanning: false };
    return cache;
  }

  const accountKey = settingsStore.getConfig().imapUser || "default";
  const store = classifications.getAll(accountKey);
  // Let op: "categorie" ontbreken is de echte maatstaf voor "nog niet gescand"
  // — een mail kan al een store-record hebben omdat ze al als afgehandeld is
  // gemarkeerd (via setResolved) vóór de AI-classificatie ooit liep.
  const unclassified = light.filter((m) => !store[m.uid] || store[m.uid].categorie === undefined);

  if (unclassified.length) {
    // Nieuwste onbeoordeelde mails eerst (meest relevant), de rest van de
    // achterstand volgt automatisch in de volgende ververs-rondes.
    const batch = unclassified.slice(0, SCAN_BATCH_SIZE);
    let snippetByUid = new Map();
    try {
      snippetByUid = await mailbox.fetchSnippetsForUids(batch.map((m) => m.uid));
    } catch (e) {
      console.error("Fragmenten ophalen mislukt:", e.message);
    }
    const forAi = batch.map((m) => ({ ...m, snippet: snippetByUid.get(m.uid) || "" }));
    let results = [];
    try {
      results = await ai.classifyMails(forAi);
    } catch (e) {
      console.error("Classificatie mislukt:", e.message);
    }
    const byUid = Object.fromEntries(results.map((c) => [c.uid, c]));
    const toStore = forAi.map((m) => ({
      uid: m.uid,
      categorie: byUid[m.uid]?.categorie || "onbekend",
      reden: byUid[m.uid]?.reden || "",
      vanType: byUid[m.uid]?.vanType || "onbekend",
      actieLabel: byUid[m.uid]?.actieLabel || "",
      snippet: m.snippet,
    }));
    classifications.setMany(accountKey, toStore);
  }

  const finalStore = classifications.getAll(accountKey);
  const merged = light.map((m) => {
    const c = finalStore[m.uid];
    return {
      ...m,
      snippet: c?.snippet || "",
      categorie: c?.categorie || "onbekend",
      reden: c?.reden || "",
      vanType: c?.vanType || "onbekend",
      actieLabel: c?.actieLabel || "",
      resolved: !!c?.resolved,
    };
  });

  const scanned = merged.filter((m) => finalStore[m.uid]).length;
  cache = {
    at: Date.now(),
    mails: merged,
    total,
    capped,
    scanned,
    scanning: scanned < light.length,
  };
  suggestionCache.clear();
  return cache;
}

app.get("/api/status", (req, res) => {
  res.json({
    imapConfigured: mailbox.isConfigured(),
    smtpConfigured: mailer.isConfigured(),
    aiConfigured: ai.isConfigured(),
  });
});

app.get("/api/settings", (req, res) => {
  res.json(settingsStore.getPublicConfig());
});

app.post("/api/settings", (req, res) => {
  try {
    const updated = settingsStore.updateSettings(req.body || {});
    cache = { at: 0, mails: [], total: 0, capped: false, scanned: 0, scanning: false }; // cache leegmaken zodat nieuwe instellingen meteen gelden
    envelopeCache = { at: 0, mails: [], total: 0, capped: false };
    suggestionCache.clear();
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de instellingen niet opslaan.", detail: e.message });
  }
});

app.get("/api/mails", async (req, res) => {
  try {
    const data = await getMails(req.query.refresh === "1");
    res.json({
      imapConfigured: mailbox.isConfigured(),
      smtpConfigured: mailer.isConfigured(),
      aiConfigured: ai.isConfigured(),
      mails: data.mails,
      total: data.total,
      capped: data.capped,
      envelopeCap: mailbox.ENVELOPE_CAP,
      scanned: data.scanned,
      scanning: data.scanning,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mailbox niet ophalen.", detail: e.message });
  }
});

app.get("/api/mails/:uid", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const data = await getMails(false);
    const meta = data.mails.find((m) => m.uid === uid) || {};
    const body = await mailbox.fetchMailBody(uid);
    if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
    res.json({ ...meta, ...body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mail niet ophalen.", detail: e.message });
  }
});

app.get("/api/mails/:uid/suggestion", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    if (suggestionCache.has(uid)) {
      return res.json(suggestionCache.get(uid));
    }
    const data = await getMails(false);
    const meta = data.mails.find((m) => m.uid === uid) || {};
    const body = await mailbox.fetchMailBody(uid);
    if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
    const suggestion = await ai.suggestReply({ ...meta, ...body });
    suggestionCache.set(uid, suggestion);
    res.json(suggestion);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon geen voorstel opstellen.", detail: e.message });
  }
});

// Markeert een mail als (niet-)afgehandeld. Dit is de ENIGE manier waarop een
// mail uit "Openstaande Zaken"/"Actie nodig"/Vandaag verdwijnt — nooit door
// tijdsverloop of een herscan.
app.post("/api/mails/:uid/resolve", (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const resolved = req.body?.resolved !== false;
    const accountKey = settingsStore.getConfig().imapUser || "default";
    classifications.setResolved(accountKey, uid, resolved);
    cache.mails = (cache.mails || []).map((m) => (m.uid === uid ? { ...m, resolved } : m));
    res.json({ ok: true, resolved });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mail niet bijwerken.", detail: e.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const data = await mailbox.searchMails(q);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Zoeken mislukt.", detail: e.message, mails: [] });
  }
});

app.get("/api/klant/:address", async (req, res) => {
  try {
    const address = decodeURIComponent(req.params.address);
    const data = await mailbox.fetchMailsFromAddress(address);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de klantgeschiedenis niet ophalen.", detail: e.message, mails: [] });
  }
});

app.get("/api/followups", async (req, res) => {
  try {
    const data = await mailbox.fetchFollowUps();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de opvolgingen niet ophalen.", detail: e.message, configured: mailbox.isConfigured(), supported: false, items: [] });
  }
});

app.post("/api/rewrite", async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Geen tekst meegegeven." });
  }
  try {
    const rewritten = await ai.rewriteProfessional(text);
    res.json({ text: rewritten });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Herschrijven mislukt.", detail: e.message });
  }
});

app.post("/api/send", async (req, res) => {
  const { to, subject, text, resolveUid } = req.body || {};
  if (!to || !subject || !text) {
    return res.status(400).json({ error: "Vul ontvanger, onderwerp en tekst in." });
  }
  try {
    await mailer.sendMail({ to, subject, text });
    // Een effectief verstuurd antwoord telt als "beantwoord" — de originele
    // mail mag dan uit de openstaande-zaken-lijsten verdwijnen.
    if (resolveUid) {
      const uid = Number(resolveUid);
      const accountKey = settingsStore.getConfig().imapUser || "default";
      classifications.setResolved(accountKey, uid, true);
      cache.mails = (cache.mails || []).map((m) => (m.uid === uid ? { ...m, resolved: true } : m));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Verzenden mislukt.", detail: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Geen vraag meegegeven." });
  }
  try {
    const data = await getMails(false);
    const answer = await ai.chat(message, data.mails);
    res.json({ answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "De AI kon niet antwoorden.", detail: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Mailvio draait op poort ${PORT}`);
});
