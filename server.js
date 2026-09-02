require("dotenv").config();
const express = require("express");
const path = require("path");
const mailbox = require("./mailbox");
const ai = require("./ai");
const mailer = require("./mailer");
const settingsStore = require("./settings");
const classifications = require("./classifications");
const mailstore = require("./mailstore");
const auth = require("./auth");

const app = express();
// Ruimer dan standaard: bijlagen (offerte-pdf, dakfoto's) worden als tekst
// meegestuurd in de aanvraag en zijn daardoor ongeveer een derde groter.
app.use(express.json({ limit: "25mb" }));

// ---------------------------------------------------------------------------
// Beveiliging: zonder inloggen komt niemand aan je mail
// ---------------------------------------------------------------------------
// Alles zit achter een slot, behalve het inlogscherm zelf en de paar routes
// die het nodig heeft. Zo kan niemand die het webadres kent zomaar meelezen.
const OPEN_ROUTES = new Set(["/api/auth/status", "/api/auth/login", "/api/auth/setup"]);

app.use((req, res, next) => {
  // Het inlogscherm en zijn eigen bestanden moeten uiteraard bereikbaar zijn.
  if (req.path === "/login.html" || req.path === "/favicon.ico") return next();
  if (OPEN_ROUTES.has(req.path)) return next();

  const ingelogd = auth.sessieGeldig(auth.tokenUitVerzoek(req));
  if (ingelogd) return next();

  // Nog geen wachtwoord ingesteld? Dan sturen we naar het inlogscherm, waar je
  // er meteen eentje kiest.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Niet ingelogd.", login: true });
  }
  return res.redirect("/login.html");
});

app.use(express.static(path.join(__dirname, "public")));

// --- Inloggen ---------------------------------------------------------------
app.get("/api/auth/status", (req, res) => {
  res.json({
    ingesteld: auth.isIngesteld(),
    ingelogd: auth.sessieGeldig(auth.tokenUitVerzoek(req)),
  });
});

// De allereerste keer: zelf een wachtwoord kiezen. Kan maar één keer — daarna
// verloopt het via "wachtwoord wijzigen", waarvoor je het oude nodig hebt.
app.post("/api/auth/setup", (req, res) => {
  if (auth.isIngesteld()) {
    return res.status(400).json({ error: "Er is al een wachtwoord ingesteld." });
  }
  try {
    auth.stelWachtwoordIn(req.body?.wachtwoord);
    const s = auth.nieuweSessie();
    auth.zetCookie(res, s.token, s.verlooptOp);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Eenvoudige rem op raden: na te veel foute pogingen even wachten.
const pogingen = new Map();
const MAX_POGINGEN = 8;
const REM_MS = 10 * 60 * 1000;

app.post("/api/auth/login", (req, res) => {
  const ip = req.headers["fly-client-ip"] || req.ip || "onbekend";
  const staat = pogingen.get(ip) || { aantal: 0, tot: 0 };
  if (staat.tot > Date.now()) {
    const minuten = Math.ceil((staat.tot - Date.now()) / 60000);
    return res.status(429).json({ error: `Te veel pogingen. Probeer het over ${minuten} minuten opnieuw.` });
  }
  if (!auth.isIngesteld()) {
    return res.status(400).json({ error: "Er is nog geen wachtwoord ingesteld.", setup: true });
  }
  if (!auth.klopt(req.body?.wachtwoord)) {
    staat.aantal += 1;
    if (staat.aantal >= MAX_POGINGEN) {
      staat.tot = Date.now() + REM_MS;
      staat.aantal = 0;
    }
    pogingen.set(ip, staat);
    return res.status(401).json({ error: "Wachtwoord klopt niet." });
  }
  pogingen.delete(ip);
  const s = auth.nieuweSessie();
  auth.zetCookie(res, s.token, s.verlooptOp);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  auth.beeindigSessie(auth.tokenUitVerzoek(req));
  auth.wisCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/wachtwoord", (req, res) => {
  try {
    auth.wijzigWachtwoord(req.body?.oud, req.body?.nieuw);
    const s = auth.nieuweSessie();
    auth.zetCookie(res, s.token, s.verlooptOp);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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
// Kleinere porties: 40 mails tegelijk inlezen kostte te veel geheugen op een
// kleine server. 15 per keer scant even snel door, maar veel rustiger.
const SCAN_BATCH_SIZE = 15;
let cache = { at: 0, mails: [], total: 0, capped: false, scanned: 0, scanning: false };
const suggestionCache = new Map(); // uid -> voorstel, leegt mee met de mail-cache
let folderCache = { at: 0, folders: [] };
const FOLDER_CACHE_TTL_MS = 5 * 60 * 1000;

// Hoeveel recente mails we bij een ververs opnieuw op gelezen/ongelezen
// controleren — zodat een mail die je op je gsm las hier ook gelezen wordt.
const VLAGGEN_CONTROLE = 60;
// Hoeveel oudere mails we per ronde extra binnenhalen bij een grote mailbox.
const BACKFILL_BATCH = 300;
let backfillResterend = 0;

// Haalt de kopregels op. Werkt als Outlook: wat we al hebben komt van de
// schijf (dus meteen zichtbaar), en van de server halen we enkel de NIEUWE
// berichten op. Zo hoeft je mailbox nooit meer volledig opnieuw ingeladen te
// worden — ook niet na een herstart van de app.
async function getLightMails(forceRefresh) {
  const accountKey = settingsStore.getConfig().imapUser || "default";
  const bewaard = mailstore.getMails(accountKey, "INBOX");

  const fresh = !forceRefresh && Date.now() - envelopeCache.at < ENVELOPE_CACHE_TTL_MS && envelopeCache.mails.length > 0;
  if (fresh) return { configured: true, ...envelopeCache };

  if (!mailbox.isConfigured()) {
    return { configured: false, mails: [], total: 0, capped: false };
  }

  let mails = bewaard;
  try {
    const hoogste = mailstore.getHoogsteUid(accountKey, "INBOX");
    const vorigeValidity = mailstore.getUidValidity(accountKey, "INBOX");

    const data = await mailbox.fetchNieuweMails("INBOX", hoogste);
    if (data.configured) {
      // Wisselt de mailserver van nummering, dan kloppen onze bewaarde
      // nummers niet meer en beginnen we voor deze map opnieuw.
      if (vorigeValidity && data.uidValidity && vorigeValidity !== data.uidValidity) {
        console.log("uidValidity gewijzigd — mailcache voor INBOX opnieuw opbouwen");
        mailstore.wisMap(accountKey, "INBOX");
        const volledig = await mailbox.fetchAllMails("INBOX");
        mailstore.bewaarMails(accountKey, "INBOX", volledig.mails, data.uidValidity);
      } else {
        if (data.nieuwe.length) {
          mailstore.bewaarMails(accountKey, "INBOX", data.nieuwe, data.uidValidity);
        }
        // Wat op de server weg is (verplaatst of verwijderd), hier ook weghalen.
        if (data.alleUids && data.alleUids.length) {
          mailstore.verwijderOntbrekende(accountKey, "INBOX", data.alleUids);
        }
        // Gelezen-status van de recentste berichten bijwerken.
        const recent = mailstore.getMails(accountKey, "INBOX").slice(0, VLAGGEN_CONTROLE).map((m) => m.uid);
        if (recent.length) {
          const vlaggen = await mailbox.fetchVlaggen("INBOX", recent);
          for (const [uid, v] of vlaggen) mailstore.werkBij(accountKey, "INBOX", uid, v);
        }

        // Achterstand wegwerken: bij een grote mailbox (duizenden mails) halen
        // we per ronde een portie oudere berichten erbij, tot alles binnen is.
        if (!mailstore.isVolledig(accountKey, "INBOX")) {
          const laagste = mailstore.getLaagsteUid(accountKey, "INBOX");
          if (laagste > 0) {
            const ouder = await mailbox.fetchOudereMails("INBOX", laagste, BACKFILL_BATCH);
            if (ouder.mails && ouder.mails.length) {
              mailstore.bewaarMails(accountKey, "INBOX", ouder.mails, data.uidValidity);
            }
            if (ouder.klaar) mailstore.markeerVolledig(accountKey, "INBOX");
            backfillResterend = ouder.resterend || 0;
          }
        }
      }
      mails = mailstore.getMails(accountKey, "INBOX");
    }
  } catch (e) {
    // Server even niet bereikbaar? Dan tonen we gewoon wat we al hebben.
    console.error("Nieuwe mails ophalen mislukt, bewaarde mails worden getoond:", e.message);
    if (!mails.length) return { configured: true, mails: [], total: 0, capped: false };
  }

  envelopeCache = { at: Date.now(), mails, total: mails.length, capped: false };
  return { configured: true, mails, total: mails.length, capped: false };
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
      soort: byUid[m.uid]?.soort || "overig",
      belangrijk: !!byUid[m.uid]?.belangrijk,
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
      soort: c?.soort || "overig",
      belangrijk: !!c?.belangrijk,
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

// Alles wat per mailbox verschilt uit het geheugen gooien. Nodig bij het
// wisselen van mailbox, anders zie je even de mails van de vorige.
function leegCaches() {
  cache = { at: 0, mails: [], total: 0, capped: false, scanned: 0, scanning: false };
  envelopeCache = { at: 0, mails: [], total: 0, capped: false };
  folderCache = { at: 0, folders: [] };
  suggestionCache.clear();
}

app.get("/api/accounts", (req, res) => {
  res.json({ accounts: settingsStore.getAccounts(), actief: settingsStore.getActiveIndex() });
});

app.post("/api/accounts/actief", (req, res) => {
  try {
    const actief = settingsStore.setActiveIndex(req.body?.index);
    leegCaches();
    res.json({ ok: true, actief, accounts: settingsStore.getAccounts() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/accounts", (req, res) => {
  try {
    const actief = settingsStore.addAccount();
    leegCaches();
    res.json({ ok: true, actief, accounts: settingsStore.getAccounts() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/accounts/:index", (req, res) => {
  try {
    const accounts = settingsStore.removeAccount(req.params.index);
    leegCaches();
    res.json({ ok: true, accounts, actief: settingsStore.getActiveIndex() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
      // Hoeveel oudere mails er nog opgehaald moeten worden bij een grote mailbox.
      backfillResterend,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mailbox niet ophalen.", detail: e.message });
  }
});

// De echte mappenstructuur van de mailbox (Inbox, Verzonden, Concepten,
// Archief, Prullenmand + eigen mappen), zodat de zijbalk geen vaste lijst is.
app.get("/api/folders", async (req, res) => {
  try {
    if (!mailbox.isConfigured()) return res.json({ configured: false, folders: [] });
    const vers = Date.now() - folderCache.at < FOLDER_CACHE_TTL_MS && folderCache.folders.length > 0;
    if (vers && req.query.refresh !== "1") {
      return res.json({ configured: true, folders: folderCache.folders });
    }
    const data = await mailbox.listFolders();
    if (data.configured) folderCache = { at: Date.now(), folders: data.folders };
    res.json(data);
  } catch (e) {
    console.error("Kon de mappen niet ophalen:", e.message);
    res.status(500).json({ error: "Kon de mappen niet ophalen.", detail: e.message });
  }
});

// Bladeren door een andere map dan de inbox (Verzonden, Concepten, ...).
// Bewust zonder AI-beoordeling: dat hoort bij de inbox, niet bij je archief.
app.get("/api/folder-mails", async (req, res) => {
  try {
    const folder = req.query.folder;
    if (!folder) return res.status(400).json({ error: "Geen map opgegeven." });
    const data = await mailbox.fetchAllMails(folder);
    res.json({
      configured: data.configured,
      folder,
      mails: data.mails,
      total: data.total,
      capped: data.capped,
      envelopeCap: mailbox.ENVELOPE_CAP,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon deze map niet openen.", detail: e.message });
  }
});

app.get("/api/mails/:uid", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const folder = req.query.folder;
    // Mail uit een andere map: geen AI-gegevens, gewoon de inhoud tonen.
    if (folder && folder !== "INBOX") {
      const body = await mailbox.fetchMailBody(uid, folder);
      if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
      return res.json(body);
    }
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

// Zet een afspraak uit een mail om in een agenda-bestand (.ics) dat opent in
// Apple Agenda, Google Agenda of Outlook — zonder koppeling met een agenda.
// Let op: bewust ZONDER "Z" op het einde. Dat betekent in een agenda-bestand
// "lokale tijd", zodat 14u30 in de mail ook 14u30 in de agenda wordt. Met een
// Z zou de agenda het als UTC lezen en er in de zomer 16u30 van maken.
function icsDatum(datum, tijd, minutenLater) {
  const [j, m, d] = String(datum).split("-").map(Number);
  const [uu, mm] = (tijd || "09:00").split(":").map(Number);
  const dt = new Date(Date.UTC(j, (m || 1) - 1, d || 1, uu || 9, mm || 0));
  if (minutenLater) dt.setUTCMinutes(dt.getUTCMinutes() + minutenLater);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00`;
}

function icsTekst(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

app.get("/api/mails/:uid/afspraak", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const folder = req.query.folder;
    const body = await mailbox.fetchMailBody(uid, folder);
    if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
    const afspraak = await ai.extractAfspraak(body);
    if (!afspraak.gevonden || !afspraak.datum) {
      return res.json({ gevonden: false, reden: "Geen datum of afspraak gevonden in deze mail." });
    }
    res.json({ gevonden: true, ...afspraak, van: body.from, vanAdres: body.fromAddress });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon er geen afspraak uit halen.", detail: e.message });
  }
});

app.post("/api/afspraak.ics", (req, res) => {
  try {
    const { titel, datum, begin, duur, plaats, notitie } = req.body || {};
    if (!datum) return res.status(400).json({ error: "Geen datum opgegeven." });
    const minuten = Number(duur) || 60;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Mailvio//NL",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:mailvio-${Date.now()}@daklo.be`,
      `DTSTAMP:${icsDatum(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(11, 16))}Z`,
      `DTSTART:${icsDatum(datum, begin)}`,
      `DTEND:${icsDatum(datum, begin, minuten)}`,
      `SUMMARY:${icsTekst(titel || "Afspraak")}`,
      plaats ? `LOCATION:${icsTekst(plaats)}` : "",
      notitie ? `DESCRIPTION:${icsTekst(notitie)}` : "",
      "END:VEVENT",
      "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="afspraak.ics"');
    res.send(ics);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon het agenda-bestand niet maken.", detail: e.message });
  }
});

// Adresboek: alle afzenders uit je mailbox, zodat je een adres niet volledig
// hoeft te typen. Wordt afgeleid uit de mails die al ingeladen zijn.
app.get("/api/contacten", async (req, res) => {
  try {
    const data = await getMails(false);
    const perAdres = new Map();
    for (const m of data.mails || []) {
      const adres = (m.fromAddress || "").toLowerCase();
      if (!adres || !adres.includes("@")) continue;
      const bestaand = perAdres.get(adres);
      if (bestaand) {
        bestaand.aantal += 1;
        if (m.date && (!bestaand.laatst || m.date > bestaand.laatst)) bestaand.laatst = m.date;
      } else {
        perAdres.set(adres, { adres, naam: m.from || adres, aantal: 1, laatst: m.date || null });
      }
    }
    const contacten = [...perAdres.values()].sort((a, b) => b.aantal - a.aantal || String(b.laatst).localeCompare(String(a.laatst)));
    res.json({ contacten });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de contacten niet ophalen.", contacten: [] });
  }
});

// Een onafgewerkte mail als concept bewaren op de mailserver.
app.post("/api/draft", async (req, res) => {
  const { to, cc, subject, text, attachments } = req.body || {};
  if (!subject && !text && !to) {
    return res.status(400).json({ error: "Er valt nog niets te bewaren." });
  }
  try {
    const result = await mailer.saveDraft({ to, cc, subject, text, attachments });
    if (!result.ok) {
      return res.status(400).json({ error: result.reden === "geen map Concepten gevonden"
        ? "Je mailserver heeft geen map 'Concepten'."
        : "Kon het concept niet bewaren." });
    }
    folderCache = { at: 0, folders: [] };
    res.json({ ok: true, map: result.map });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon het concept niet bewaren.", detail: e.message });
  }
});

// Een bijlage openen/downloaden (offerte, factuur, foto van een dak, ...).
app.get("/api/mails/:uid/bijlage/:index", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const index = Number(req.params.index);
    const att = await mailbox.fetchAttachment(uid, index, req.query.folder);
    if (!att) return res.status(404).json({ error: "Bijlage niet gevonden." });
    // Bestandsnaam veilig houden voor de Content-Disposition-header.
    const veiligeNaam = String(att.filename).replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", att.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${veiligeNaam}"`);
    res.send(att.content);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de bijlage niet openen.", detail: e.message });
  }
});

// Gelezen / ongelezen markeren — zoals in elke gewone mailbox.
app.post("/api/mails/:uid/read", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const gelezen = req.body?.read !== false;
    const folder = req.body?.folder;
    await mailbox.markeerGelezen(uid, gelezen, folder);
    cache.mails = (cache.mails || []).map((m) => (m.uid === uid ? { ...m, unread: !gelezen } : m));
    envelopeCache.mails = (envelopeCache.mails || []).map((m) => (m.uid === uid ? { ...m, unread: !gelezen } : m));
    res.json({ ok: true, unread: !gelezen });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mail niet bijwerken.", detail: e.message });
  }
});

// Archiveren of naar de prullenmand verplaatsen.
app.post("/api/mails/:uid/move", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const doel = req.body?.to === "prullenmand" ? "prullenmand" : "archief";
    const folder = req.body?.folder;
    const result = await mailbox.verplaatsMail(uid, doel, folder);
    // Weg uit de inbox: ook uit de caches halen zodat de lijst meteen klopt.
    cache.mails = (cache.mails || []).filter((m) => m.uid !== uid);
    envelopeCache.mails = (envelopeCache.mails || []).filter((m) => m.uid !== uid);
    folderCache = { at: 0, folders: [] };
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mail niet verplaatsen.", detail: e.message });
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
  const { to, cc, subject, text, resolveUid, inReplyTo, references, attachments } = req.body || {};
  if (!to || !subject || !text) {
    return res.status(400).json({ error: "Vul ontvanger, onderwerp en tekst in." });
  }
  try {
    await mailer.sendMail({ to, cc, subject, text, inReplyTo, references, attachments });
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
