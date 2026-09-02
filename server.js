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
const afzenders = require("./afzenders");
const bijlagen = require("./bijlagen");
const taken = require("./taken");
const agenda = require("./agenda");
const regels = require("./regels");
const klanten = require("./klanten");

const app = express();
// Ruimer dan standaard: bijlagen (offerte-pdf, dakfoto's) worden als tekst
// meegestuurd in de aanvraag en zijn daardoor ongeveer een derde groter.
app.use(express.json({ limit: "25mb" }));

// ---------------------------------------------------------------------------
// Beveiliging: zonder inloggen komt niemand aan je mail
// ---------------------------------------------------------------------------
// Alles zit achter een slot, behalve het inlogscherm zelf en de paar routes
// die het nodig heeft. Zo kan niemand die het webadres kent zomaar meelezen.
// Deze routes werken zonder ingelogd te zijn. /api/agenda.ics hoort daarbij
// omdat Google Agenda hem zelf komt ophalen; die is beveiligd met een lange
// geheime sleutel in het adres zelf.
const OPEN_ROUTES = new Set(["/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/agenda.ics"]);

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

// De pagina zelf nooit uit de cache serveren: anders blijft je browser na een
// nieuwe versie de oude Mailvio tonen, en lijken opgeloste fouten er nog te
// zitten. Afbeeldingen en dergelijke mogen wel gewoon gecachet worden.
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  setHeaders(res, bestandspad) {
    if (/\.(html)$/i.test(bestandspad)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

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
    auth.zetCookie(res, s.token, s.verlooptOp, req);
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
  auth.zetCookie(res, s.token, s.verlooptOp, req);
  res.json({ ok: true });
});

// Het automatiseringsscherm vraagt je wachtwoord opnieuw. Niet omdat het
// gevoeliger is dan je mailbox, maar als drempel: hier verander je hoe de app
// zich gedraagt, en dat wil je niet per ongeluk doen.
app.post("/api/auth/controleer", (req, res) => {
  const ok = auth.klopt((req.body || {}).wachtwoord);
  res.json({ ok });
});

app.post("/api/auth/logout", (req, res) => {
  auth.beeindigSessie(auth.tokenUitVerzoek(req));
  auth.wisCookie(res, req);
  res.json({ ok: true });
});

app.post("/api/auth/wachtwoord", (req, res) => {
  try {
    auth.wijzigWachtwoord(req.body?.oud, req.body?.nieuw);
    const s = auth.nieuweSessie();
    auth.zetCookie(res, s.token, s.verlooptOp, req);
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
// Hoeveel mails de AI per ronde beoordeelt. Groter = de achterstand van een
// grote mailbox is sneller weggewerkt; te groot maakt één oproep traag en duur.
const SCAN_BATCH_SIZE = 30;
// Hoeveel mails we per portie volledig inladen. Ze gaan over één verbinding, en
// de achtergrondronde blijft porties halen tot je HELE mailbox binnen is.
const VOORAF_PER_RONDE = 60;
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

// Synchroniseert ÉÉN map met de mailserver: nieuwe berichten erbij, verdwenen
// berichten eruit, gelezen-status bijwerken, en per ronde een portie oudere
// berichten binnenhalen tot de map volledig op schijf staat. Werkt voor de
// inbox én voor Verzonden, Archief, Prullenmand en je eigen mappen — zo hoeft
// geen enkele map ooit nog volledig opnieuw ingeladen te worden.
async function syncMap(accountKey, folder, opties = {}) {
  const backfill = opties.backfill === undefined ? BACKFILL_BATCH : opties.backfill;
  const hoogste = mailstore.getHoogsteUid(accountKey, folder);
  const vorigeValidity = mailstore.getUidValidity(accountKey, folder);

  const data = await mailbox.fetchNieuweMails(folder, hoogste);
  if (!data.configured) return mailstore.getMails(accountKey, folder);

  if (vorigeValidity && data.uidValidity && vorigeValidity !== data.uidValidity) {
    console.log(`uidValidity gewijzigd — mailcache voor ${folder} opnieuw opbouwen`);
    mailstore.wisMap(accountKey, folder);
    const volledig = await mailbox.fetchAllMails(folder);
    mailstore.bewaarMails(accountKey, folder, volledig.mails, data.uidValidity);
    return mailstore.getMails(accountKey, folder);
  }

  if (data.nieuwe.length) mailstore.bewaarMails(accountKey, folder, data.nieuwe, data.uidValidity);
  if (data.alleUids && data.alleUids.length) mailstore.verwijderOntbrekende(accountKey, folder, data.alleUids);

  const recent = mailstore.getMails(accountKey, folder).slice(0, VLAGGEN_CONTROLE).map((m) => m.uid);
  if (recent.length) {
    const vlaggen = await mailbox.fetchVlaggen(folder, recent);
    for (const [uid, v] of vlaggen) mailstore.werkBij(accountKey, folder, uid, v);
  }

  // DE ACHTERSTAND WEGWERKEN. Bij een mailbox van duizenden berichten haalden
  // we er vroeger 300 per ronde bij, en een ronde liep maar één keer per drie
  // minuten — negen weken... nee, anderhalf uur voor 9000 mails. Veel te traag.
  // Nu blijven we doorwerken tot de map VOLLEDIG op schijf staat.
  if (backfill && !mailstore.isVolledig(accountKey, folder)) {
    const maxRondes = opties.totVolledig ? 200 : 1;
    for (let i = 0; i < maxRondes; i++) {
      const laagste = mailstore.getLaagsteUid(accountKey, folder);
      if (laagste <= 0) break;
      const ouder = await mailbox.fetchOudereMails(folder, laagste, backfill);
      if (ouder.mails && ouder.mails.length) mailstore.bewaarMails(accountKey, folder, ouder.mails, data.uidValidity);
      if (folder === "INBOX") backfillResterend = ouder.resterend || 0;
      if (ouder.klaar) { mailstore.markeerVolledig(accountKey, folder); break; }
      if (!ouder.mails || !ouder.mails.length) break;
    }
  }
  return mailstore.getMails(accountKey, folder);
}

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

  // NIET LATEN WACHTEN. Hebben we al mails op schijf staan, dan geven we die
  // METEEN terug en halen we de nieuwe post op de achtergrond op. Vroeger bleef
  // je scherm hangen tot de mailserver klaar was — soms tientallen seconden.
  // De achtergrondronde ververst de cache, dus binnen een paar tellen staat de
  // nieuwe post er vanzelf bij.
  // ZELFS BIJ "VERVERS" NIET LATEN WACHTEN. Ook als jij op de ververs-knop
  // duwt, krijg je meteen wat er op schijf staat en gaat het ophalen op de
  // achtergrond verder. Anders sta je bij elke ververs weer te kijken naar een
  // scherm dat niks doet terwijl de mailserver zijn tijd neemt.
  if (bewaard.length) {
    // Op de achtergrond bijwerken. Bewust syncMap en NIET getLightMails, want
    // die zou hier weer op dezelfde snelkoppeling belanden en dus nooit iets
    // ophalen.
    if (!getLightMails._bezig) {
      getLightMails._bezig = true;
      syncMap(accountKey, "INBOX")
        .then(() => {
          const bij = mailstore.getMails(accountKey, "INBOX");
          envelopeCache = { at: Date.now(), mails: bij, total: bij.length, capped: false };
          cache.at = 0; // zodat de volgende oproep de nieuwe post meeneemt
        })
        .catch((e) => console.error("Achtergrondsynchronisatie mislukt:", e.message))
        .finally(() => { getLightMails._bezig = false; });
    }
    envelopeCache = { at: Date.now(), mails: bewaard, total: bewaard.length, capped: false };
    // Alvast de inhoud van de nieuwste mails ophalen, zodat ze meteen openen
    // wanneer je erop klikt.
    laadVoorafIn(accountKey);
    return { configured: true, mails: bewaard, total: bewaard.length, capped: false };
  }

  let mails = bewaard;
  try {
    mails = await syncMap(accountKey, "INBOX");
  } catch (e) {
    // Server even niet bereikbaar? Dan tonen we gewoon wat we al hebben.
    console.error("Nieuwe mails ophalen mislukt, bewaarde mails worden getoond:", e.message);
    if (!mails.length) return { configured: true, mails: [], total: 0, capped: false };
  }

  envelopeCache = { at: Date.now(), mails, total: mails.length, capped: false };
  return { configured: true, mails, total: mails.length, capped: false };
}

// Beoordeelt een portie nog niet gescande mails met de AI. Draait op de
// achtergrond: niemand zit erop te wachten.
let beoordeelBezig = false;
async function beoordeelPortie(accountKey, unclassified) {
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
      // Onthouden zodat de app het KAN TONEN. Een stille fout hier betekent dat
      // je mailbox niet beoordeeld wordt en je nergens ziet waarom.
      ai.onthoudFout(e);
    }
    // De AI hoort een lijst terug te geven. Geeft ze iets anders (dat gebeurt
    // zelden, maar het gebeurt), dan mag dat niet je hele inbox blokkeren:
    // de mails komen dan gewoon zonder beoordeling binnen.
    const byUid = Object.fromEntries(
      (Array.isArray(results) ? results : []).filter((c) => c && c.uid !== undefined).map((c) => [c.uid, c])
    );
    // Enkel bewaren wat de AI effectief beoordeeld heeft. Kwam een mail niet
    // terug in het antwoord, dan slaan we ze NIET op als "onbekend" — dan
    // wordt ze de volgende ronde gewoon opnieuw voorgelegd.
    const toStore = forAi.filter((m) => byUid[m.uid]).map((m) => ({
      uid: m.uid,
      categorie: byUid[m.uid]?.categorie || "geen_actie",
      reden: byUid[m.uid]?.reden || "",
      vanType: byUid[m.uid]?.vanType || "onbekend",
      actieLabel: byUid[m.uid]?.actieLabel || "",
      soort: byUid[m.uid]?.soort || "overig",
      belangrijk: !!byUid[m.uid]?.belangrijk,
      viaWebsite: !!byUid[m.uid]?.viaWebsite,
      reclameTwijfel: !!byUid[m.uid]?.reclameTwijfel,
      snippet: m.snippet,
    }));
    if (results && results.length) ai.wisFout();
    classifications.setMany(accountKey, toStore);
    // Mails waar de AI niets over teruggaf: een poging aanrekenen, zodat ze niet
    // eindeloos opnieuw aangeboden worden.
    const gelukt = new Set(toStore.map((t) => String(t.uid)));
    const mislukt = forAi.filter((m) => !gelukt.has(String(m.uid))).map((m) => m.uid);
    if (mislukt.length) classifications.telPoging(accountKey, mislukt);
  
  // De cache verversen zodat de nieuwe beoordelingen meteen meekomen.
  cache.at = 0;
}

// Haalt op de achtergrond de inhoud op van de mails die je waarschijnlijk gaat
// openen. Loopt rustig verder en houdt bij wat er al is, zodat er nooit iets
// dubbel gehaald wordt.
let voorafBezig = false;
async function laadVoorafIn(accountKey, maxRondes) {
  if (!mailbox.isConfigured()) return;
  // Loopt er al een portie? Bij een gewone aanvraag laten we die met rust; de
  // achtergrondronde (die alles moet binnenhalen) wacht wel even tot ze klaar
  // is, anders zou die zichzelf overslaan en nooit verder geraken.
  if (voorafBezig) {
    if (!maxRondes) return;
    for (let w = 0; w < 60 && voorafBezig; w++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (voorafBezig) return;
  }
  voorafBezig = true;
  try {
    // ALLE mails, niet enkel de recentste. Zoals in Outlook: wat één keer
    // binnengehaald is, opent daarna meteen. We blijven porties halen tot je
    // hele mailbox binnen is.
    const rondes = maxRondes || 1;
    for (let i = 0; i < rondes; i++) {
      const alle = mailstore.getMails(accountKey, "INBOX");
      const teDoen = [];
      for (const m of alle) {
        if (mailstore.getBody(accountKey, "INBOX", m.uid)) continue;
        teDoen.push(m.uid);
        if (teDoen.length >= VOORAF_PER_RONDE) break;
      }
      if (!teDoen.length) break;

      // Eerst wachten tot jij niets aan het doen bent. Een mailserver laat maar
      // een paar verbindingen toe; zonder deze pauze moest jouw klik wachten op
      // het inladen op de achtergrond.
      await mailbox.wachtOpRust();
      if (mailbox.gebruikerBezig()) break;

      // In één keer over ÉÉN verbinding. Per mail apart verbinden kost een halve
      // seconde aan aanmelden alleen al — bij duizenden mails is dat uren.
      let bewaard = 0;
      await mailbox.fetchMailBodies(teDoen, "INBOX", (mail) => {
        bewaarInhoud(accountKey, "INBOX", mail.uid, mail, mailstore.getBody(accountKey, "INBOX", mail.uid));
        bewaard++;
      });
      if (!bewaard) break; // lukt het niet, dan stoppen we deze ronde
      console.log(`${bewaard} mails ingeladen (portie ${i + 1}).`);
      // Even de app laten ademen tussen twee porties. Zonder deze adempauze
      // draait het inladen honderd porties na elkaar af zonder ooit een klik
      // van jou te behandelen.
      await new Promise((r) => setImmediate(r));
    }
  } catch (e) {
    console.error("Vooraf inladen mislukt:", e.message);
  } finally {
    voorafBezig = false;
  }
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
  // "onbekend" telt NIET als beoordeeld. Zo worden mails die eerder door een
  // afgekapt AI-antwoord verkeerd als onbekend zijn weggeschreven, alsnog
  // opnieuw beoordeeld in plaats van voorgoed leeg te blijven.
  // WAT IS "NOG NIET BEOORDEELD"?
  // Een mail zonder oordeel, of een mail waar de AI "onbekend" van maakte —
  // maar hoogstens MAX_POGINGEN keer. Zonder die grens werd dezelfde mail elke
  // ronde opnieuw naar de AI gestuurd, eindeloos, en dat kost tegoed en tijd.
  // Een oordeel dat er eenmaal staat, blijft staan: dat wordt NOOIT opnieuw
  // gedaan (behalve als jij zelf op "Mailbox opnieuw beoordelen" duwt).
  const MAX_POGINGEN = 3;
  const unclassified = light.filter((m) => {
    const c = store[m.uid];
    if (!c) return true;
    if ((c.pogingen || 0) >= MAX_POGINGEN) return false;
    return c.categorie === undefined || c.categorie === "onbekend";
  });

  // NIET WACHTEN OP DE AI. Vroeger werd hier eerst een portie mails door Claude
  // beoordeeld voordat de server antwoordde — inclusief het ophalen van de
  // fragmenten over IMAP. Dat kon tientallen seconden duren, elke keer dat je de
  // app opende. Nu vertrekt het antwoord meteen en gebeurt de beoordeling op de
  // achtergrond; het lampje in de zijbalk toont de voortgang.
  if (unclassified.length && !beoordeelBezig) {
    beoordeelBezig = true;
    beoordeelPortie(accountKey, unclassified)
      .catch((e) => console.error("Beoordelen mislukt:", e.message))
      .finally(() => { beoordeelBezig = false; });
  }

  const finalStore = classifications.getAll(accountKey);
  const merged = light.map((m) => {
    const c = finalStore[m.uid];
    const basis = {
      ...m,
      snippet: c?.snippet || "",
      categorie: c?.categorie || "onbekend",
      reden: c?.reden || "",
      vanType: c?.vanType || "onbekend",
      actieLabel: c?.actieLabel || "",
      soort: c?.soort || "overig",
      belangrijk: !!c?.belangrijk,
      viaWebsite: !!c?.viaWebsite,
      reclameTwijfel: !!c?.reclameTwijfel,
      resolved: !!c?.resolved,
      genegeerd: !!c?.genegeerd,
    };

    // Staat "Reclame herkennen" uit, dan telt het oordeel van de AI daarover
    // niet mee en blijft alles gewone post.
    if (!regels.aanstaat(accountKey, "reclame_herkennen") && basis.soort === "reclame") {
      basis.soort = "overig";
    }
    if (!regels.aanstaat(accountKey, "reclame_vragen")) basis.reclameTwijfel = false;

    // Wat JIJ ooit over deze afzender besliste, weegt zwaarder dan het
    // oordeel van de AI — en de vraag wordt dan ook niet meer gesteld.
    const beslist = regels.aanstaat(accountKey, "afzender_onthouden")
      ? afzenders.oordeel(accountKey, m.fromAddress)
      : null;
    if (beslist) {
      basis.reclameTwijfel = false;
      basis.afzenderBeslist = true;
      if (beslist.reclame) {
        basis.soort = "reclame";
        basis.categorie = "geen_actie";
        basis.actieLabel = "";
        basis.belangrijk = false;
      } else if (basis.soort === "reclame") {
        // Jij zei dat dit géén reclame is: dan blijft het een gewone mail.
        basis.soort = "overig";
      }
    }

    // Een aanvraag via zijn website of via dakwAIrker is altijd het belangrijkst.
    // Ook als de AI het gemist heeft, herkennen we die afzenders hier zelf.
    const aanvraagAfzender = /daklo\.be|dakwairker/i.test(`${m.fromAddress || ""} ${m.from || ""}`);
    if (aanvraagAfzender && basis.soort === "reclame") basis.soort = "overig";
    if ((basis.viaWebsite || aanvraagAfzender) && regels.aanstaat(accountKey, "website_voorrang")) {
      basis.belangrijk = true;
      basis.vanType = "klant";
      if (basis.categorie === "geen_actie" || basis.categorie === "onbekend") {
        basis.categorie = "dringend";
      }
      if (!basis.actieLabel) basis.actieLabel = "Beantwoorden";
    }

    // Jouw eigen regels komen als laatste: die overrulen alles hierboven.
    const geraakt = regels.pasToe(accountKey, m, basis);
    if (geraakt.length) {
      basis.regels = geraakt.map((r) => r.naam);
      // "Maak er een taak van" kan enkel hier, want de takenlijst zit apart.
      for (const r of geraakt) {
        if (!r.acties.includes("taak")) continue;
        const bestaat = taken.getAlle(accountKey).some((t) => (t.mails || []).some((x) => String(x.uid) === String(m.uid)));
        if (!bestaat) {
          taken.voegToe(accountKey, m.subject || "Mail opvolgen", {
            notitie: `Automatisch aangemaakt door de regel "${r.naam}".`,
            mails: [{ uid: m.uid, folder: "INBOX", subject: m.subject || "", from: m.from || "", fromAddress: m.fromAddress || "", date: m.date || null }],
          });
        }
      }
    }

    return basis;
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
  // De voorstellencache NIET volledig leegmaken: tijdens het scannen loopt deze
  // functie elke drie seconden, en dan zou elk AI-antwoord dat je net kreeg
  // meteen weggegooid worden — met een nieuwe AI-oproep als gevolg zodra je die
  // mail opent. We ruimen enkel op wat niet meer in de mailbox staat.
  const bestaandeUids = new Set(merged.map((m) => m.uid));
  for (const uid of [...suggestionCache.keys()]) {
    if (!bestaandeUids.has(uid)) suggestionCache.delete(uid);
  }
  return cache;
}

app.get("/api/status", (req, res) => {
  const fout = ai.getLaatsteFout();
  res.json({
    // Zo kan de app ALTIJD tonen of de AI werkt of niet — en waarom niet.
    aiFout: fout ? fout.uitleg : "",
    aiWerkt: ai.isConfigured() && !fout,
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
// Een andere map openen (Verzonden, Archief, Prullenmand, je eigen mappen).
// Net als de inbox: wat al op schijf staat komt METEEN op je scherm, en de
// nieuwe berichten worden op de achtergrond bijgehaald. Zo hoeft Verzonden met
// zijn duizenden berichten nooit meer volledig ingeladen te worden.
const mapBezig = new Set();
app.get("/api/folder-mails", async (req, res) => {
  try {
    const folder = req.query.folder;
    if (!folder) return res.status(400).json({ error: "Geen map opgegeven." });
    if (!mailbox.isConfigured()) return res.json({ configured: false, folder, mails: [], total: 0 });

    const accountKey = settingsStore.getConfig().imapUser || "default";
    const bewaard = mailstore.getMails(accountKey, folder);

    if (bewaard.length) {
      // Op de achtergrond bijwerken, maar de gebruiker niet laten wachten.
      if (!mapBezig.has(folder)) {
        mapBezig.add(folder);
        syncMap(accountKey, folder)
          .catch((e) => console.error(`Map ${folder} bijwerken mislukt:`, e.message))
          .finally(() => mapBezig.delete(folder));
      }
      return res.json({
        configured: true, folder, mails: bewaard, total: bewaard.length,
        capped: false, envelopeCap: mailbox.ENVELOPE_CAP,
        volledig: mailstore.isVolledig(accountKey, folder),
      });
    }

    // Eerste keer: nu wél ophalen, en meteen bewaren voor de volgende keer.
    const mails = await syncMap(accountKey, folder);
    res.json({
      configured: true, folder, mails, total: mails.length,
      capped: false, envelopeCap: mailbox.ENVELOPE_CAP,
      volledig: mailstore.isVolledig(accountKey, folder),
    });
  } catch (e) {
    console.error("Map openen mislukt:", e.message);
    res.status(500).json({ error: "Kon deze map niet openen.", detail: e.message });
  }
});

// DE INHOUD VAN EEN GEOPENDE MAIL WORDT BEWAARD.
// Dit was de grote fout: mailstore had al functies om mailinhoud te bewaren
// (bewaarBody/getBody), maar ze werden NERGENS gebruikt. Elke keer dat je een
// mail opende, werd het volledige bericht — inclusief bijlagen — opnieuw van de
// mailserver gehaald. Vandaar dat openen seconden tot minuten duurde.
// Nu: eerst kijken of we ze al hebben. Zo ja, dan is het scherm er meteen.
// LEGE INHOUD IS GEEN INHOUD. Sommige mails stonden bewaard met een lege tekst
// én lege html (bv. als een bulk-ophaling halverwege afbrak). Die werden daarna
// eeuwig als "we hebben ze al" teruggegeven en jij zag een leeg scherm. Zoiets
// wordt nu weggegooid en opnieuw opgehaald.
function leesbaar(body) {
  if (!body) return false;
  if (body.html && String(body.html).trim()) return true;
  if (body.text && String(body.text).trim()) return true;
  // Een mail die enkel uit bijlagen bestaat is ook geldig.
  return Array.isArray(body.attachments) && body.attachments.length > 0;
}

// Een mail die ECHT leeg is (dat bestaat: enkel een onderwerp) wordt na twee
// pogingen toch bewaard. Anders zou de server zo'n bericht bij elke ronde
// opnieuw gaan ophalen en nooit klaar zijn.
const LEEG_MAX = 2;
function bewaarInhoud(accountKey, map, uid, body, vorige) {
  if (!body) return;
  if (leesbaar(body)) return mailstore.bewaarBody(accountKey, map, uid, body);
  const pogingen = ((vorige && vorige.leegPogingen) || 0) + 1;
  mailstore.bewaarBody(accountKey, map, uid, { ...body, leegPogingen: pogingen });
}

async function haalMailOp(accountKey, uid, folder) {
  const map = folder || "INBOX";
  const bewaard = mailstore.getBody(accountKey, map, uid);
  if (leesbaar(bewaard)) return bewaard;
  if (bewaard && (bewaard.leegPogingen || 0) >= LEEG_MAX) return bewaard;
  const body = await mailbox.fetchMailBody(uid, map === "INBOX" ? undefined : map);
  bewaarInhoud(accountKey, map, uid, body, bewaard);
  return body || bewaard;
}

app.get("/api/mails/:uid", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const folder = req.query.folder;
    const accountKey = settingsStore.getConfig().imapUser || "default";

    // Mail uit een andere map: geen AI-gegevens, gewoon de inhoud tonen.
    if (folder && folder !== "INBOX") {
      const body = await haalMailOp(accountKey, uid, folder);
      if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
      return res.json(body);
    }
    const body = await haalMailOp(accountKey, uid, "INBOX");
    if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
    // De beoordeling erbij halen uit wat we al hebben — zonder de mailserver.
    const meta = (cache.mails || []).find((m) => m.uid === uid) ||
      (await getMails(false)).mails.find((m) => m.uid === uid) || {};
    res.json({ ...meta, ...body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mail niet ophalen.", detail: e.message });
  }
});

app.get("/api/mails/:uid/suggestion", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    // "Maak een nieuw antwoord" stuurt force=1 mee: dan negeren we het bewaarde
    // voorstel en laten we de AI er echt een ander maken.
    const opnieuw = req.query.force === "1" || req.headers["x-force"] === "1";
    if (!opnieuw && suggestionCache.has(uid)) {
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
// Niet meer opvolgen — de mail blijft staan, maar telt niet meer mee als
// openstaande zaak. Terugdraaien kan altijd.
app.post("/api/mails/:uid/negeer", (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const genegeerd = req.body?.genegeerd !== false;
    const accountKey = settingsStore.getConfig().imapUser || "default";
    classifications.setGenegeerd(accountKey, uid, genegeerd);
    cache.mails = (cache.mails || []).map((m) => (m.uid === uid ? { ...m, genegeerd, resolved: genegeerd ? true : m.resolved } : m));
    res.json({ ok: true, genegeerd });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de mail niet bijwerken.", detail: e.message });
  }
});

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
    if (!regels.aanstaat(taakAccount(), "afspraak_herkennen")) {
      return res.json({ gevonden: false, reden: "Afspraken uit mails halen staat uit bij Automatisering — vul de datum hieronder zelf in." });
    }
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

// Een bijlage in twee zinnen laten samenvatten. Het resultaat blijft bewaard,
// zodat dezelfde bijlage nooit twee keer gelezen moet worden.
app.get("/api/mails/:uid/bijlage/:index/samenvatting", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const index = Number(req.params.index);
    const folder = req.query.folder || "INBOX";
    const accountKey = settingsStore.getConfig().imapUser || "default";

    if (!regels.aanstaat(accountKey, "bijlage_samenvatten")) {
      return res.json({ samenvatting: "", reden: "Bijlagen samenvatten staat uit bij Automatisering." });
    }

    const bewaard = bijlagen.get(accountKey, folder, uid, index);
    if (bewaard) return res.json(bewaard);

    if (!ai.isConfigured()) {
      return res.json({ samenvatting: "", reden: "De AI is nog niet ingesteld." });
    }
    const att = await mailbox.fetchAttachment(uid, index, folder);
    if (!att) return res.status(404).json({ error: "Bijlage niet gevonden." });

    const resultaat = await ai.vatBijlageSamen(att);
    bijlagen.bewaar(accountKey, folder, uid, index, resultaat);
    res.json(resultaat);
  } catch (e) {
    console.error("Bijlage samenvatten mislukt:", e.message);
    res.status(500).json({ error: "Kon de bijlage niet samenvatten.", detail: e.message });
  }
});

// ---------------------------------------------------------------------------
// To-dolijst
// ---------------------------------------------------------------------------
// Taken die je zelf typt én mails die je in de to-domap sleept. Elke taak kan
// subtaken hebben en afgevinkt worden.
function taakAccount() {
  return settingsStore.getConfig().imapUser || "default";
}

app.get("/api/taken", (req, res) => {
  res.json({ taken: taken.getAlle(taakAccount()) });
});

app.post("/api/taken", (req, res) => {
  const { titel, mail, notitie } = req.body || {};
  const taak = taken.voegToe(taakAccount(), titel, {
    notitie,
    mails: mail ? [{ uid: mail.uid, folder: mail.folder || "INBOX", subject: mail.subject || "", from: mail.from || "", fromAddress: mail.fromAddress || "", date: mail.date || null }] : [],
  });
  if (!taak) return res.status(400).json({ error: "Geef een omschrijving voor de taak." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
});

app.patch("/api/taken/:id", (req, res) => {
  const taak = taken.wijzig(taakAccount(), req.params.id, req.body || {});
  if (!taak) return res.status(404).json({ error: "Taak niet gevonden." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
});

app.delete("/api/taken/:id", (req, res) => {
  taken.verwijder(taakAccount(), req.params.id);
  res.json({ ok: true, taken: taken.getAlle(taakAccount()) });
});

app.post("/api/taken/:id/subtaak", (req, res) => {
  const taak = taken.voegSubtaakToe(taakAccount(), req.params.id, (req.body || {}).titel);
  if (!taak) return res.status(400).json({ error: "Kon de subtaak niet toevoegen." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
});

app.patch("/api/taken/:id/subtaak/:subId", (req, res) => {
  const taak = taken.wijzigSubtaak(taakAccount(), req.params.id, req.params.subId, req.body || {});
  if (!taak) return res.status(404).json({ error: "Subtaak niet gevonden." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
});

app.delete("/api/taken/:id/subtaak/:subId", (req, res) => {
  const taak = taken.verwijderSubtaak(taakAccount(), req.params.id, req.params.subId);
  if (!taak) return res.status(404).json({ error: "Taak niet gevonden." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
});

app.post("/api/taken/:id/mail", (req, res) => {
  const taak = taken.koppelMail(taakAccount(), req.params.id, req.body || {});
  if (!taak) return res.status(404).json({ error: "Taak niet gevonden." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
});

app.delete("/api/taken/:id/mail/:uid", (req, res) => {
  const taak = taken.ontkoppelMail(taakAccount(), req.params.id, req.params.uid, req.query.folder);
  if (!taak) return res.status(404).json({ error: "Taak niet gevonden." });
  res.json({ taak, taken: taken.getAlle(taakAccount()) });
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

// ---------------------------------------------------------------------------
// Opruimen: mails die weg mogen
// ---------------------------------------------------------------------------
// Alleen wat DUIDELIJK weg mag komt hier terecht. Bij twijfel niet: dan blijft
// de mail gewoon staan. Wat wel in aanmerking komt:
//   - reclame en nieuwsbrieven ouder dan twee maanden waar je nooit iets mee
//     gedaan hebt (niet beantwoord, niet als taak gezet, niet belangrijk)
// Gewone mails komen hier NOOIT in, hoe oud ook — die kan je later nog nodig
// hebben. Enkel reclame.
// Niets wordt automatisch verwijderd: jij vinkt aan en drukt op de knop.
const OPRUIM_RECLAME_DAGEN = 60;
const OPRUIM_OUD_JAREN = 4;

function opruimVoorstellen(mails, accountKey) {
  const nu = Date.now();
  const dag = 86400000;
  const taakUids = new Set();
  for (const t of taken.getAlle(accountKey)) {
    for (const m of t.mails || []) taakUids.add(String(m.uid));
  }

  const voorstellen = [];
  for (const m of mails) {
    if (!m.date) continue;
    if (m.belangrijk || m.viaWebsite) continue;        // nooit iets belangrijks
    if (taakUids.has(String(m.uid))) continue;         // hangt aan een taak
    if (m.reclameTwijfel && !m.afzenderBeslist) continue; // twijfel: niet aanraken
    const ouderdom = (nu - new Date(m.date).getTime()) / dag;
    const openZaak = !m.resolved && !m.genegeerd && m.categorie &&
      m.categorie !== "geen_actie" && m.categorie !== "onbekend";

    if (m.soort === "reclame" && ouderdom > OPRUIM_RECLAME_DAGEN && !openZaak) {
      voorstellen.push({ ...m, reden: `Reclame van ${Math.round(ouderdom)} dagen oud, nooit iets mee gedaan.`, groep: "reclame" });
      continue;
    }
    // Bewust GEEN oude gewone mails meer voorstellen. Een mail van vier jaar
    // geleden kan nog altijd een offerte of een garantie zijn die je nodig hebt.
    // Enkel reclame mag hier in.
  }
  voorstellen.sort((a, b) => new Date(a.date) - new Date(b.date));
  return voorstellen;
}

// Uitproberen of een model werkt met jouw sleutel, vóór je het instelt.
app.post("/api/ai/testmodel", async (req, res) => {
  const resultaat = await ai.testModel((req.body || {}).model);
  res.json(resultaat);
});

app.get("/api/opruimen", async (req, res) => {
  try {
    const data = await getMails(false);
    const accountKey = settingsStore.getConfig().imapUser || "default";
    const lijst = opruimVoorstellen(data.mails || [], accountKey);
    res.json({
      configured: data.configured !== false,
      voorstellen: lijst,
      reclame: lijst.filter((m) => m.groep === "reclame").length,
      oud: lijst.filter((m) => m.groep === "oud").length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de opruimlijst niet maken.", detail: e.message, voorstellen: [] });
  }
});

// Meerdere mails tegelijk naar de prullenmand. Ze zijn daar niet weg: je kan ze
// altijd nog terughalen tot je de prullenmand zelf leegt.
app.post("/api/mails/verwijder-meerdere", async (req, res) => {
  const uids = Array.isArray((req.body || {}).uids) ? req.body.uids.map(Number).filter(Boolean) : [];
  if (!uids.length) return res.status(400).json({ error: "Geen mails aangeduid." });
  let gelukt = 0;
  const mislukt = [];
  for (const uid of uids) {
    try {
      await mailbox.verplaatsMail(uid, "prullenmand", req.body.folder);
      gelukt++;
      cache.mails = (cache.mails || []).filter((m) => m.uid !== uid);
      envelopeCache.mails = (envelopeCache.mails || []).filter((m) => m.uid !== uid);
    } catch (e) {
      mislukt.push({ uid, reden: e.message });
    }
  }
  folderCache = { at: 0, folders: [] };
  res.json({ ok: true, gelukt, mislukt });
});

// Jouw beslissing over een afzender bewaren: is dit reclame of niet? Vanaf nu
// gaat alle post van dat adres automatisch de juiste kant op.
app.post("/api/afzender/oordeel", (req, res) => {
  try {
    const { adres, reclame, heelDomein } = req.body || {};
    if (!adres) return res.status(400).json({ error: "Geen afzender opgegeven." });
    const accountKey = settingsStore.getConfig().imapUser || "default";
    afzenders.beslis(accountKey, adres, !!reclame, !!heelDomein);
    // Cache leegmaken zodat de lijsten meteen kloppen.
    cache.at = 0;
    res.json({ ok: true, adres, reclame: !!reclame });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon dit niet bewaren.", detail: e.message });
  }
});

app.get("/api/afzender/overzicht", (req, res) => {
  const accountKey = settingsStore.getConfig().imapUser || "default";
  res.json({ afzenders: afzenders.overzicht(accountKey) });
});

app.post("/api/afzender/vergeet", (req, res) => {
  const accountKey = settingsStore.getConfig().imapUser || "default";
  afzenders.vergeet(accountKey, req.body?.adres);
  cache.at = 0;
  res.json({ ok: true });
});

// Zoeken gebeurt EERST in wat Mailvio al bewaard heeft. Alle opgehaalde mails
// staan met hun fragment en hun AI-beoordeling op schijf, dus daar zoeken kost
// geen mailserver-verbinding en gaat vrijwel meteen. Levert dat niets op, dan
// pas vragen we het aan de mailserver — voor iets dat nog niet ingeladen was.
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ configured: mailbox.isConfigured(), mails: [] });

    const accountKey = settingsStore.getConfig().imapUser || "default";
    const termen = q.toLowerCase().split(/\s+/).filter(Boolean);
    const labels = classifications.getAll(accountKey);

    const bewaard = [];
    for (const map of mailstore.getMappen(accountKey)) {
      for (const m of mailstore.getMails(accountKey, map)) {
        const c = labels[m.uid] || {};
        const hooi = `${m.from || ""} ${m.fromAddress || ""} ${m.subject || ""} ${c.snippet || m.snippet || ""}`.toLowerCase();
        if (termen.every((t) => hooi.includes(t))) {
          bewaard.push({ ...m, snippet: c.snippet || m.snippet || "", categorie: c.categorie, soort: c.soort, folder: map });
        }
      }
    }
    bewaard.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (bewaard.length) {
      return res.json({ configured: true, mails: bewaard.slice(0, 80), bron: "bewaard" });
    }

    // Niets in het geheugen? Dan toch even bij de mailserver kijken.
    const data = await mailbox.searchMails(q);
    res.json({ ...data, bron: "mailserver" });
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

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------
// Afspraken worden hier bewaard zodat je in Mailvio zelf een weekoverzicht hebt.
// Het .ics-bestand blijft bestaan om ze ook in Apple/Google Agenda te zetten.
// De agenda als abonneerbaar .ics-adres. Google Agenda, Apple Agenda en Outlook
// kunnen dit adres "volgen": alles wat je in Mailvio vastlegt, verschijnt dan
// vanzelf in je gewone agenda, en blijft mee wijzigen.
app.get("/api/agenda.ics", (req, res) => {
  try {
    const sleutel = String(req.query.sleutel || "");
    const juiste = agenda.abonnementsSleutel();
    // Vergelijken op een manier die niets verraadt via de tijd die het duurt.
    const a = Buffer.from(sleutel.padEnd(juiste.length).slice(0, juiste.length));
    const b = Buffer.from(juiste);
    if (!sleutel || !require("crypto").timingSafeEqual(a, b)) {
      return res.status(404).send("Niet gevonden.");
    }
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="mailvio.ics"');
    res.setHeader("Cache-Control", "no-cache");
    res.send(agenda.alsIcs(settingsStore.getConfig().imapUser || "default"));
  } catch (e) {
    console.error("Agenda-abonnement mislukt:", e.message);
    res.status(500).send("Kon de agenda niet opbouwen.");
  }
});

// Het adres om in Google Agenda te plakken, en de mogelijkheid om het te
// vernieuwen als je het per ongeluk gedeeld hebt.
app.get("/api/agenda/abonnement", (req, res) => {
  const basis = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${basis}/api/agenda.ics?sleutel=${agenda.abonnementsSleutel()}` });
});

app.post("/api/agenda/abonnement/nieuw", (req, res) => {
  const basis = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${basis}/api/agenda.ics?sleutel=${agenda.nieuweSleutel()}` });
});

app.get("/api/agenda", (req, res) => {
  const accountKey = taakAccount();
  const { van, tot } = req.query;
  const lijst = van && tot ? agenda.getTussen(accountKey, van, tot) : agenda.getAlle(accountKey);
  res.json({ afspraken: lijst });
});

app.post("/api/agenda", (req, res) => {
  const item = agenda.voegToe(taakAccount(), req.body || {});
  if (!item) return res.status(400).json({ error: "Een afspraak heeft minstens een datum nodig." });
  res.json({ afspraak: item, afspraken: agenda.getAlle(taakAccount()) });
});

app.patch("/api/agenda/:id", (req, res) => {
  const item = agenda.wijzig(taakAccount(), req.params.id, req.body || {});
  if (!item) return res.status(404).json({ error: "Afspraak niet gevonden." });
  res.json({ afspraak: item, afspraken: agenda.getAlle(taakAccount()) });
});

app.delete("/api/agenda/:id", (req, res) => {
  agenda.verwijder(taakAccount(), req.params.id);
  res.json({ ok: true, afspraken: agenda.getAlle(taakAccount()) });
});

// De klantenfiche: één blik op alles wat je met deze persoon te maken hebt —
// een korte AI-samenvatting, wat er nog openstaat, wanneer je nog langsgaat,
// en de volledige mailgeschiedenis.
app.get("/api/klant/:address/fiche", async (req, res) => {
  try {
    const address = decodeURIComponent(req.params.address);
    const accountKey = taakAccount();
    const data = await mailbox.fetchMailsFromAddress(address);
    const mails = data.mails || [];

    const labels = classifications.getAll(accountKey);
    const openstaand = mails
      .map((m) => ({ ...m, ...(labels[m.uid] || {}) }))
      .filter((m) => !m.resolved && m.categorie && m.categorie !== "geen_actie" && m.categorie !== "onbekend");

    const volgende = agenda.volgendeVoor(accountKey, address);
    const taakLijst = taken
      .getAlle(accountKey)
      .filter((t) => !t.klaar && (t.mails || []).some((m) => String(m.fromAddress || "").toLowerCase() === address.toLowerCase()));

    // Wat je zelf noteerde blijft altijd staan; de gegevens uit de mails worden
    // bewaard zodat de fiche meteen gevuld is bij een volgend bezoek.
    const bewaard = klanten.get(accountKey, address) || {};

    // Telefoonnummers, adressen en websites die LETTERLIJK in de mails staan.
    // Dit gebeurt met vaste patronen, dus zonder AI en zonder gokwerk.
    const uitTekst = klanten.haalUitTekst(mails.slice(0, 40).map((m) => `${m.subject || ""}\n${m.snippet || ""}`));

    let vanAi = bewaard.gegevens || null;
    // De AI enkel opnieuw laten lezen als we nog niets hebben, of als er sinds
    // de vorige keer nieuwe mails bijgekomen zijn.
    const nieuwsteMail = mails.length ? new Date(mails[0].date || 0).getTime() : 0;
    const verouderd = !vanAi || (bewaard.gegevensOp || 0) < nieuwsteMail;
    if (ai.isConfigured() && mails.length && verouderd && !req.query.snel) {
      try {
        vanAi = await ai.vatKlantSamen(address, mails.slice(0, 15));
        klanten.zetGegevens(accountKey, address, vanAi);
      } catch (e) {
        console.error("Klantsamenvatting mislukt:", e.message);
      }
    }

    // De twee bronnen samenvoegen, zonder dubbels. Wat letterlijk in een mail
    // staat komt eerst — dat is het zekerst.
    const uniek = (lijst) => {
      const gezien = new Set();
      return lijst.filter((x) => {
        const sleutel = String(x || "").replace(/[^\d\w]/g, "").toLowerCase();
        if (!sleutel || gezien.has(sleutel)) return false;
        gezien.add(sleutel);
        return true;
      });
    };

    res.json({
      configured: data.configured,
      adres: address,
      mails,
      openstaand,
      volgendeAfspraak: volgende,
      taken: taakLijst,
      samenvatting: (vanAi && vanAi.samenvatting) || "",
      bedrijf: (vanAi && vanAi.bedrijf) || "",
      contactpersonen: (vanAi && vanAi.contactpersonen) || [],
      aandachtspunten: (vanAi && vanAi.aandachtspunten) || [],
      telefoons: uniek([...uitTekst.telefoons, ...((vanAi && vanAi.telefoons) || [])]).slice(0, 5),
      adressen: uniek([...uitTekst.adressen, ...((vanAi && vanAi.adressen) || [])]).slice(0, 4),
      websites: uitTekst.websites,
      notitie: bewaard.notitie || "",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de klantenfiche niet opbouwen.", detail: e.message, mails: [] });
  }
});

// ---------------------------------------------------------------------------
// Automatiseringsregels
// ---------------------------------------------------------------------------
// Alles opnieuw laten beoordelen. Nodig wanneer de AI slimmer geworden is —
// bv. nu ze oplichting en boekhouding herkent — want mails die al beoordeeld
// zijn worden anders niet meer opnieuw bekeken. Kost AI-oproepen, dus het
// gebeurt enkel als jij erom vraagt.
app.post("/api/herbeoordeel", (req, res) => {
  try {
    const accountKey = taakAccount();
    const aantal = classifications.wisBeoordelingen(accountKey);
    cache = { at: 0, mails: [], total: 0, capped: false, scanned: 0, scanning: false };
    envelopeCache = { at: 0, mails: [], total: 0, capped: false };
    achtergrondRonde();
    res.json({ ok: true, aantal });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de herbeoordeling niet starten.", detail: e.message });
  }
});

app.get("/api/regels", (req, res) => {
  res.json(regels.overzicht(taakAccount()));
});

app.post("/api/regels/ingebouwd", (req, res) => {
  const { sleutel, aan } = req.body || {};
  const resultaat = regels.zetIngebouwd(taakAccount(), sleutel, aan);
  if (!resultaat) return res.status(400).json({ error: "Onbekende regel." });
  cache.at = 0; // opnieuw beoordelen met de nieuwe instelling
  res.json(resultaat);
});

// Uit een zin in gewone taal een regelvoorstel maken. Er wordt niets bewaard:
// je krijgt een voorstel te zien en beslist zelf of je het toevoegt.
app.post("/api/regels/voorstel", async (req, res) => {
  try {
    if (!ai.isConfigured()) return res.json({ gelukt: false, uitleg: "De AI is nog niet ingesteld." });
    const voorstel = await ai.stelRegelVoor((req.body || {}).beschrijving);
    res.json(voorstel);
  } catch (e) {
    console.error("Regelvoorstel mislukt:", e.message);
    res.status(500).json({ gelukt: false, uitleg: "Kon er geen regel van maken: " + e.message });
  }
});

app.post("/api/regels", (req, res) => {
  const regel = regels.voegToe(taakAccount(), req.body || {});
  if (!regel) return res.status(400).json({ error: "Vul een waarde in en kies minstens één actie." });
  cache.at = 0;
  res.json({ regel, ...regels.overzicht(taakAccount()) });
});

app.patch("/api/regels/:id", (req, res) => {
  const regel = regels.wijzigEigen(taakAccount(), req.params.id, req.body || {});
  if (!regel) return res.status(404).json({ error: "Regel niet gevonden." });
  cache.at = 0;
  res.json({ regel, ...regels.overzicht(taakAccount()) });
});

app.delete("/api/regels/:id", (req, res) => {
  regels.verwijderEigen(taakAccount(), req.params.id);
  cache.at = 0;
  res.json(regels.overzicht(taakAccount()));
});

// Je eigen notitie bij een klant ("belt liefst na 17u", "poort links achteraan").
app.post("/api/klant/:address/notitie", (req, res) => {
  try {
    const address = decodeURIComponent(req.params.address);
    const resultaat = klanten.zetNotitie(taakAccount(), address, (req.body || {}).notitie);
    res.json({ ok: true, notitie: resultaat ? resultaat.notitie : "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de notitie niet bewaren.", detail: e.message });
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
    if (resolveUid && regels.aanstaat(taakAccount(), "antwoord_afhandelen")) {
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
// ---------------------------------------------------------------------------
// Op de achtergrond blijven bijwerken
// ---------------------------------------------------------------------------
// Mailvio wacht niet tot jij de app opent. De server haalt zelf om de paar
// minuten nieuwe mails op en laat de AI ze meteen beoordelen. Open je daarna de
// app, dan staat alles er al — geen wachtbalk meer.
const ACHTERGROND_MS = 3 * 60 * 1000;   // elke drie minuten kijken of er nieuwe post is
const EERSTE_START_MS = 4 * 1000;       // meteen na het opstarten beginnen
let achtergrondBezig = false;

async function achtergrondRonde() {
  if (achtergrondBezig) return;
  if (!mailbox.isConfigured()) return;
  achtergrondBezig = true;
  try {
    // Nieuwe mails ophalen en beoordelen. Zolang er nog niet-beoordeelde mails
    // zijn, doen we meteen een volgende portie — zo is de mailbox binnen een
    // paar rondes volledig doorgenomen in plaats van pas terwijl jij zit te
    // wachten.
    const accountKey0 = settingsStore.getConfig().imapUser || "default";
    // Eerst de mailbox bijwerken — en de achterstand in één keer wegwerken,
    // zodat ALLE mails op de schijf van de server komen te staan.
    const accountKeyVoor = settingsStore.getConfig().imapUser || "default";
    try {
      await syncMap(accountKeyVoor, "INBOX", { totVolledig: true });
    } catch (e) {
      console.error("Inbox volledig binnenhalen mislukt:", e.message);
    }
    cache.at = 0;
    envelopeCache = { at: 0, mails: [], total: 0, capped: false };
    await getMails(true);

    // EERST alle andere mappen binnenhalen — Verzonden, Concepten, Archief,
    // Prullenmand, Ongewenst. Die stonden vroeger achteraan de rij, ná het
    // beoordelen van duizenden mails, en waren daardoor uren later pas
    // beschikbaar. Ze horen er meteen te staan.
    try {
      const mappen0 = folderCache.folders.length ? folderCache.folders : ((await mailbox.listFolders()).folders || []);
      if (mappen0.length) folderCache = { at: Date.now(), folders: mappen0 };
      for (const f of mappen0) {
        if (!f.path || f.path.toUpperCase() === "INBOX") continue;
        if (mapBezig.has(f.path)) continue;
        mapBezig.add(f.path);
        try {
          await syncMap(accountKeyVoor, f.path, { totVolledig: true });
        } catch (e) {
          console.error(`Map ${f.path} binnenhalen mislukt:`, e.message);
        } finally {
          mapBezig.delete(f.path);
        }
      }
    } catch (e) {
      console.error("Mappen binnenhalen mislukt:", e.message);
    }

    // Dan de achterstand van de AI-beoordeling wegwerken, portie per portie.
    // Dit gebeurt hier, op de achtergrond, en niet terwijl jij op je scherm wacht.
    for (let ronde = 0; ronde < 25; ronde++) {
      const licht = mailstore.getMails(accountKey0, "INBOX");
      const store = classifications.getAll(accountKey0);
      const teDoen = licht.filter((m) => {
        const c = store[m.uid];
        if (!c) return true;
        if ((c.pogingen || 0) >= 3) return false;
        return c.categorie === undefined || c.categorie === "onbekend";
      });
      if (!teDoen.length) break;
      await beoordeelPortie(accountKey0, teDoen);
      // Blijft het mislukken (bv. een sleutel die niet aanvaard wordt), dan
      // stoppen we deze ronde in plaats van 25 keer dezelfde fout te maken.
      if (ai.getLaatsteFout()) break;
    }
    cache.at = 0;

    // PAS HIERNA de volledige inhoud van elke mail binnenhalen. Dit stond
    // vroeger VOOR de beoordeling, en dan bleef je dashboard leeg zolang er
    // duizenden berichten stonden in te laden. Het oordeel is wat je scherm
    // nodig heeft; de inhoud mag daarna komen.
    await laadVoorafIn(accountKeyVoor, 100);

    // Ook de andere mappen bijhouden — Verzonden, Archief, Prullenmand en je
    // eigen mappen. Zo staat ALLES op de schijf van de server en hoeft er nooit
    // iets opnieuw ingeladen te worden als je zo'n map opent.
    const accountKey = settingsStore.getConfig().imapUser || "default";
    try {
      const mappen = folderCache.folders.length ? folderCache.folders : ((await mailbox.listFolders()).folders || []);
      // ALLEEN bijwerken als we effectief mappen kregen. Zonder deze controle
      // werd de mappenlijst met een lege lijst overschreven zodra het ophalen
      // eens mislukte — en dan verdwenen Verzonden, Archief en Prullenmand
      // gewoon uit je zijbalk.
      if (mappen.length) folderCache = { at: Date.now(), folders: mappen };
      for (const f of mappen) {
        if (!f.path || f.path.toUpperCase() === "INBOX") continue;
        if (mapBezig.has(f.path)) continue;
        mapBezig.add(f.path);
        try {
          await syncMap(accountKey, f.path, { totVolledig: true });
        } catch (e) {
          console.error(`Map ${f.path} bijwerken mislukt:`, e.message);
        } finally {
          mapBezig.delete(f.path);
        }
      }
    } catch (e) {
      console.error("Mappen bijwerken mislukt:", e.message);
    }
  } catch (e) {
    console.error("Achtergrondronde mislukt (wordt straks opnieuw geprobeerd):", e.message);
  } finally {
    achtergrondBezig = false;
  }
}

setTimeout(() => {
  achtergrondRonde();
  setInterval(achtergrondRonde, ACHTERGROND_MS);
}, EERSTE_START_MS);

// Laatste vangnet: een onvoorziene fout mag Mailvio nooit helemaal platleggen.
// Beter een gelogde fout en een app die blijft draaien, dan een mailbox die
// plots onbereikbaar is.
process.on("uncaughtException", (err) => {
  console.error("Onverwachte fout (app blijft draaien):", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reden) => {
  console.error("Onafgehandelde belofte (app blijft draaien):", reden);
});

app.listen(PORT, () => {
  console.log(`Mailvio draait op poort ${PORT}`);
});
