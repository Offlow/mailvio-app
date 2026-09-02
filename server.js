require("dotenv").config();
const express = require("express");
const path = require("path");
const mailbox = require("./mailbox");
const ai = require("./ai");
const mailer = require("./mailer");
const settingsStore = require("./settings");
const classifications = require("./classifications");
const mailstore = require("./mailstore");
const belasting = require("./belasting");
const voorstellen = require("./voorstellen");
const tegoed = require("./tegoed");
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
// /api/snelheid staat er bewust bij: dat toont enkel hoe vlot de server draait
// (wachttijden, geheugen, en het SOORT werk dat bezig is). Geen mailgegevens,
// geen mapnamen, geen instellingen. Zo is van buitenaf te zien waaraan het ligt
// als de app traag is, zonder ergens toegang toe te geven.
const OPEN_ROUTES = new Set(["/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/agenda.ics", "/api/snelheid"]);

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

// HOEVER TERUG LATEN WE DE AI KIJKEN?
// Elke beoordeling kost geld: op de echte mailbox ongeveer 3 cent per portie
// van 30 mails. Voor 11.000 mails is dat een tientje. Je recentste post is wat
// telt; een mail van drie jaar geleden staat niet op je dashboard en vraagt
// geen antwoord meer.
// VIJFHONDERD, op vraag van Silvio. Dat is ongeveer 17 porties, dus onder de
// halve euro om je hele actuele mailbox beoordeeld te krijgen. Nieuwe post die
// binnenkomt wordt daarna gewoon meegenomen.
const BEOORDEEL_MAX_MAILS = 500;
const BEOORDEEL_MAX_OUD_MS = 550 * 86400000; // ongeveer anderhalf jaar
// Hoeveel mails we per portie volledig inladen. Ze gaan over één verbinding, en
// de achtergrondronde blijft porties halen tot je HELE mailbox binnen is.
// Hoeveel mails er per keer op de achtergrond binnengehaald worden. Bewust
// klein: de server heeft één processor, en het ontleden van echte mails kost
// rekenkracht. Liever een uur rustig doorwerken dan jou laten wachten.
const VOORAF_PER_RONDE = 60;
// En hoeveel er per keer gehaald wordt TERWIJL jij aan het werken bent. Vroeger
// werd er dan helemaal niets gehaald — en omdat jij de app nu eenmaal gebruikt,
// bleef het inladen dus staan waar het stond. Je klik gaat sowieso vooraan in
// de wachtrij, dus het mag gerust doorlopen; alleen in kleinere hapjes.
const VOORAF_PER_RONDE_DRUK = 10;
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

  belasting.zetBezig(`nieuwe mails ophalen uit ${folder}`);
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
    belasting.zetBezig(`gelezen/ongelezen nakijken in ${folder}`);
    const vlaggen = await mailbox.fetchVlaggen(folder, recent);
    // In één keer bijwerken. Per mail apart betekende per mail een lees- en
    // schrijfbeurt op de hele map — en dat is waar de server seconden op stond
    // te wachten.
    if (vlaggen && vlaggen.size) mailstore.werkBijVeel(accountKey, folder, [...vlaggen]);
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
      belasting.zetBezig(`oudere mails ophalen uit ${folder} (ronde ${i + 1})`);
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
    console.error("Nieuwe mails ophalen mislukt, bewaarde mails worden getoond:", mailbox.leesbareImapFout(e));
    if (!mails.length) return { configured: true, mails: [], total: 0, capped: false };
  }

  envelopeCache = { at: Date.now(), mails, total: mails.length, capped: false };
  return { configured: true, mails, total: mails.length, capped: false };
}

// WELKE MAPPEN HALEN WE OP DE ACHTERGROND BINNEN?
// Niet meer allemaal. Je mailbox heeft tientallen eigen mappen (per leverancier
// bijvoorbeeld). Die allemaal, elke ronde, volledig binnenhalen betekent
// honderden opdrachten naar je mailserver per uur — en daar knijpt je provider
// op dicht ("Command failed"). We doen dus alleen de mappen die er echt toe
// doen: je inbox en de standaardmappen. Een eigen map wordt binnengehaald op
// het moment dat jij ze opent, en blijft daarna gewoon bewaard.
const ACHTERGROND_ROLLEN = ["verzonden", "concepten", "archief", "prullenmand", "spam"];
function mappenVoorAchtergrond(mappen) {
  return (mappen || []).filter((f) => {
    if (!f.path || f.path.toUpperCase() === "INBOX") return false;
    if (ACHTERGROND_ROLLEN.includes(f.rol)) return true;
    // Een eigen map die we al eens opgehaald hebben, houden we wel bij.
    return mailstore.isVolledig(settingsStore.getConfig().imapUser || "default", f.path);
  });
}

// Beoordeelt een portie nog niet gescande mails met de AI. Draait op de
// achtergrond: niemand zit erop te wachten.
let beoordeelBezig = false;
async function beoordeelPortie(accountKey, unclassified) {
    // Nieuwste onbeoordeelde mails eerst (meest relevant), de rest van de
    // achterstand volgt automatisch in de volgende ververs-rondes.
    const batch = unclassified.slice(0, SCAN_BATCH_SIZE);
    // EERST KIJKEN WAT WE AL HEBBEN.
    // Voor elke mail werd hier een apart fragment van de mailserver gehaald —
    // ook als de volledige mail al op onze eigen schijf stond. Dat is dubbel
    // werk, het houdt de enige verbinding met je mailserver bezet, en het
    // vertraagt het inladen van de rest.
    let snippetByUid = new Map();
    const nogNodig = [];
    for (const m of batch) {
      const bewaardeInhoud = mailstore.getBody(accountKey, "INBOX", m.uid);
      const tekst = bewaardeInhoud && (bewaardeInhoud.text || bewaardeInhoud.snippet || "");
      if (tekst && tekst.trim()) {
        snippetByUid.set(m.uid, String(tekst).replace(/\s+/g, " ").trim().slice(0, 300));
      } else {
        nogNodig.push(m.uid);
      }
    }
    if (nogNodig.length) {
      try {
        belasting.zetBezig(`fragmenten ophalen van ${nogNodig.length} mails`);
        const extra = await mailbox.fetchSnippetsForUids(nogNodig);
        for (const [uid, tekst] of extra) snippetByUid.set(uid, tekst);
      } catch (e) {
        console.error("Fragmenten ophalen mislukt:", e.message);
      }
    }
    const forAi = batch.map((m) => ({ ...m, snippet: snippetByUid.get(m.uid) || "" }));
    let results = [];
    try {
      belasting.zetBezig(`${forAi.length} mails laten beoordelen door de AI`);
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
      aanvraag: byUid[m.uid]?.aanvraag,
      antwoordNodig: byUid[m.uid]?.antwoordNodig,
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

// ---------------------------------------------------------------------------
// HET ANTWOORD STAAT AL KLAAR VOOR JE DE MAIL OPENT
// ---------------------------------------------------------------------------
// Een antwoord laten opstellen duurt tot een minuut. Gebeurt dat pas wanneer jij
// de mail opent, dan zit jij die minuut te wachten — en dan heeft het geen nut
// meer. Daarom maakt Mailvio het voorstel al klaar zodra een mail binnen is,
// voor de recentste berichten waar effectief een antwoord op moet.
const VOORSTEL_MAILS = 250;   // hoe ver terug we voorstellen klaarzetten
// Bewust klein: elk voorstel kost een AI-oproep, en die kosten geld. Vier per
// halve minuut is ruim 400 per uur — meer dan genoeg om je recentste post
// klaar te hebben staan, zonder je tegoed op te eten.
const VOORSTEL_PER_RONDE = 4;
let voorstelBezig = false;

// MAIL VAN JEZELF AAN JEZELF IS EEN TO-DO.
// Stuur je vanuit je gsm een mailtje naar je eigen adres, dan is dat een
// geheugensteuntje. Dat hoort in je to-dolijst te staan, niet ergens in je
// inbox te verdwijnen. Het gebeurt één keer per mail: wat je daarna met die
// taak doet, blijft van jou.
function eigenMailsNaarTaken(accountKey, mails) {
  const eigenAdres = String(settingsStore.getConfig().imapUser || "").toLowerCase();
  if (!eigenAdres) return 0;
  const bestaande = new Set();
  for (const t of taken.getAlle(accountKey)) {
    for (const m of t.mails || []) bestaande.add(`${m.folder || "INBOX"}:${m.uid}`);
  }
  let gemaakt = 0;
  for (const m of mails) {
    if (String(m.fromAddress || "").toLowerCase() !== eigenAdres) continue;
    if (bestaande.has(`INBOX:${m.uid}`)) continue;
    const titel = (m.subject && m.subject !== "(geen onderwerp)") ? m.subject : (m.snippet || "Nota voor mezelf");
    const taak = taken.voegToe(accountKey, String(titel).slice(0, 160), { notitie: m.snippet || "" });
    if (taak) {
      taken.koppelMail(accountKey, taak.id, { uid: m.uid, folder: "INBOX", subject: m.subject, from: m.from, fromAddress: m.fromAddress, date: m.date });
      classifications.setGenegeerd(accountKey, m.uid, true);
      gemaakt++;
    }
    if (gemaakt >= 25) break; // niet in één klap honderden taken maken
  }
  if (gemaakt) console.log(`${gemaakt} mail(s) van jezelf aan jezelf op je to-dolijst gezet.`);
  return gemaakt;
}

async function maakVoorstellenKlaar(accountKey) {
  if (voorstelBezig || !ai.isConfigured()) return;
  voorstelBezig = true;
  try {
    const data = await getMails(false);
    // Alleen waar het echt over gaat: verse post die om een antwoord vraagt.
    // Een antwoord klaarzetten voor een mail van twee jaar geleden kost geld en
    // levert niets op.
    const grens = Date.now() - 45 * 86400000;
    const kandidaten = (data.mails || [])
      .slice(0, VOORSTEL_MAILS)
      .filter((m) => !m.resolved && !m.genegeerd)
      .filter((m) => m.soort !== "reclame" && m.soort !== "phishing")
      // ENKEL BIJ AANVRAGEN. Dat is waar een klaarstaand antwoord je tijd
      // bespaart; overal elders kost het enkel tegoed.
      .filter((m) => m.aanvraag && m.antwoordNodig !== false)
      .filter((m) => m.categorie && m.categorie !== "geen_actie" && m.categorie !== "onbekend")
      .filter((m) => {
        const t = m.date ? Date.parse(m.date) : 0;
        return !Number.isFinite(t) || t >= grens;
      })
      .filter((m) => !voorstellen.heeft(accountKey, m.uid));

    let gemaakt = 0;
    for (const m of kandidaten) {
      if (gemaakt >= VOORSTEL_PER_RONDE) break;
      if (!tegoed.magNog()) {
        console.log("Daggrens voor het AI-tegoed bereikt — vanaf nu enkel nog wat je zelf aanklikt.");
        break;
      }
      // Wacht tot jij klaar bent in plaats van te stoppen — anders komt het er
      // nooit van, want jij gebruikt de app nu eenmaal.
      await mailbox.wachtOpRust();
      await belasting.wachtOpRust();
      if (mailbox.gebruikerBezig() || belasting.afgeknepen()) break;
      belasting.zetBezig("antwoord klaarzetten");
      try {
        const body = await haalMailOp(accountKey, m.uid, "INBOX");
        if (!body) continue;
        // Op de achtergrond met het goedkope model — dat scheelt een veelvoud
        // in kosten en het verschil merk je nauwelijks. Vraag jij zelf om een
        // nieuw antwoord, dan gaat het dure model eraan te pas.
        const voorstel = await ai.suggestReply({ ...m, ...body }, { snel: true });
        if (voorstel && voorstel.antwoord) {
          voorstellen.bewaar(accountKey, m.uid, voorstel);
          gemaakt++;
        }
      } catch (e) {
        console.error(`Voorstel voor mail ${m.uid} mislukt:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (gemaakt) console.log(`${gemaakt} antwoorden alvast klaargezet (${voorstellen.aantal(accountKey)} in totaal).`);
  } catch (e) {
    console.error("Antwoorden klaarzetten mislukt:", e.message);
  } finally {
    voorstelBezig = false;
  }
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
      // Ben jij aan het werken, of hijgt de server? Dan halen we een kleiner
      // hapje — maar we halen WEL iets. Anders staat het inladen stil zolang
      // jij de app gebruikt, en dat is precies wat er misging.
      const drukte = mailbox.gebruikerBezig() || belasting.drukbezet();
      const perRonde = drukte ? VOORAF_PER_RONDE_DRUK : VOORAF_PER_RONDE;
      const alle = mailstore.getMails(accountKey, "INBOX");
      const teDoen = [];
      for (const m of alle) {
        // Nakijken zonder het bestand in te lezen — anders wordt het zoeken naar
        // "wat moet er nog?" trager naarmate er meer ingeladen is.
        if (mailstore.heeftBody(accountKey, "INBOX", m.uid)) continue;
        teDoen.push(m.uid);
        if (teDoen.length >= perRonde) break;
      }
      if (!teDoen.length) break;

      // Even ademen als de machine zelf stilstaat. Op JOU wachten we niet meer:
      // je klik krijgt sowieso voorrang in de wachtrij naar de mailserver, en na
      // élke mail wordt de app losgelaten. Wachten tot jij helemaal niets doet
      // betekende in de praktijk: nooit.
      await belasting.wachtOpRust(5000);

      // In één keer over ÉÉN verbinding. Per mail apart verbinden kost een halve
      // seconde aan aanmelden alleen al — bij duizenden mails is dat uren.
      let bewaard = 0;
      belasting.zetBezig(`inhoud inladen van ${teDoen.length} mails (portie ${i + 1})`);
      await mailbox.fetchMailBodies(teDoen, "INBOX", (mail) => {
        bewaarInhoud(accountKey, "INBOX", mail.uid, mail);
        bewaard++;
      });
      if (!bewaard) break; // lukt het niet, dan stoppen we deze ronde
      console.log(`${bewaard} mails ingeladen (portie ${i + 1}).`);
      // Een korte pauze tussen twee porties. Jouw kliks komen er sowieso al
      // tussen — na élke mail wordt de app losgelaten — dus deze pauze mag
      // kort zijn. Anderhalve seconde per portie kostte bij duizenden mails
      // uren extra.
      await new Promise((r) => setTimeout(r, 250));
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
  // HOEVER TERUG BEOORDELEN WE?
  // Elke beoordeling kost geld. Gemeten op de echte mailbox: ongeveer 3 cent
  // per portie van 30 mails. Voor 11.000 mails is dat een tientje — en voor een
  // mail van drie jaar geleden heb je dat oordeel niet nodig; die staat niet op
  // je dashboard en vraagt geen antwoord meer.
  // Daarom: enkel je recentste post, en niets ouder dan anderhalf jaar. Een
  // oude mail die je toch nodig hebt, kan je altijd zelf laten beoordelen met
  // de knop "Mailbox opnieuw beoordelen".
  const oudsteGrens = Date.now() - BEOORDEEL_MAX_OUD_MS;
  const teBeoordelen = light.slice(0, BEOORDEEL_MAX_MAILS).filter((m) => {
    const t = m.date ? Date.parse(m.date) : 0;
    return !Number.isFinite(t) || t >= oudsteGrens;
  });
  const unclassified = teBeoordelen.filter((m) => {
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
      aanvraag: c ? c.aanvraag : undefined,
      antwoordNodig: c ? c.antwoordNodig : undefined,
      resolved: !!c?.resolved,
      beantwoord: !!c?.beantwoord,
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

// Waaraan ligt het als de app traag aanvoelt? Dit vertelt het, in gewone taal.
// Geen giswerk meer: hier staat hoe lang de server stilstond en waarmee hij
// toen bezig was.
// "Zijn mijn oude mails nu al ingeladen?" — in één percentage. Het natellen
// kost even, dus het antwoord blijft een minuut geldig.
let voortgangCache = { op: 0, klaar: 0, totaal: 0, beoordeeld: 0 };
function inlaadVoortgang() {
  // Hoogstens één keer per tien seconden natellen. Stond op een minuut, en dan
  // bleef het cijfer op je scherm minutenlang stilstaan terwijl er ondertussen
  // honderden mails bijkwamen — dat las als "er gebeurt niets".
  if (Date.now() - voortgangCache.op < 10000) return voortgangCache;
  const accountKey = settingsStore.getConfig().imapUser || "default";
  let v = { totaal: 0, klaar: 0 };
  try { v = mailstore.inhoudVoortgang(accountKey, "INBOX"); } catch (e) { /* nog niets */ }
  let beoordeeld = 0;
  try {
    const store = classifications.getAll(accountKey);
    beoordeeld = Object.values(store).filter((c) => c.categorie && c.categorie !== "onbekend").length;
  } catch (e) { /* nog niets */ }
  let antwoordenKlaar = 0;
  try { antwoordenKlaar = voorstellen.aantal(accountKey); } catch (e) { /* nog niets */ }
  voortgangCache = { op: Date.now(), klaar: v.klaar, totaal: v.totaal, beoordeeld, antwoordenKlaar };
  return voortgangCache;
}

// Zonder aanmelden: enkel snelheid, niets over je mail.
app.get("/api/snelheid", (req, res) => {
  const o = belasting.anoniemOverzicht();
  const mf = mailbox.getVerbindingsFout && mailbox.getVerbindingsFout();
  o.mailserver = mf ? mf.soort : "in orde";
  const v = inlaadVoortgang();
  const pct = (n) => (v.totaal ? Math.round((n / v.totaal) * 100) : 0);
  o.inhoudIngeladenPercent = pct(v.klaar);
  // Ook de kale aantallen. Het percentage alleen zegt niets zolang er nog
  // koppen binnenkomen: dan groeit de noemer even hard mee en lijkt het alsof
  // er niets vordert, terwijl er wel degelijk mails bijgezet worden.
  o.inhoudKlaar = v.klaar;
  o.inhoudTotaal = v.totaal;
  o.beoordeeldPercent = pct(v.beoordeeld);
  o.antwoordenKlaar = v.antwoordenKlaar;
  o.aiVerbruikVandaag = tegoed.vandaagVerbruik();
  res.json({
    ...o,
    uitleg: o.ergsteBlokkades.length
      ? o.ergsteBlokkades.map((b) => `${(b.ms / 1000).toFixed(1)}s stil tijdens: ${b.bezigMet}`)
      : ["Geen enkele blokkade gemeten."],
  });
});

app.get("/api/diagnose", (req, res) => {
  const o = belasting.overzicht();
  o.inlaadVoortgang = inlaadVoortgang();
  res.json({
    ...o,
    uitleg: o.ergsteBlokkades.length
      ? o.ergsteBlokkades.map((b) => `${(b.ms / 1000).toFixed(1)}s stil tijdens: ${b.bezigMet}`)
      : ["Geen enkele blokkade gemeten. De server bleef de hele tijd vlot antwoorden."],
  });
});

app.get("/api/status", (req, res) => {
  const fout = ai.getLaatsteFout();
  res.json({
    // Zo kan de app ALTIJD tonen of de AI werkt of niet — en waarom niet.
    aiFout: fout ? fout.uitleg : "",
    aiWerkt: ai.isConfigured() && !fout,
    imapConfigured: mailbox.isConfigured(),
    smtpConfigured: mailer.isConfigured(),
    aiConfigured: ai.isConfigured(),
    // Weigert je mailserver de verbinding of je wachtwoord, dan moet dat op je
    // scherm staan. Vroeger bleef de app gewoon leeg zonder een woord uitleg.
    // Wat je AI-tegoed vandaag gekost heeft, zodat je het gewoon ziet.
    aiVerbruik: tegoed.vandaagVerbruik(),
    // De klacht over de mailbox die je nu bekijkt...
    mailFout: (mailbox.getVerbindingsFout && mailbox.getVerbindingsFout()) || null,
    // ...en die over je andere mailbox, zodat je die niet over het hoofd ziet.
    andereMailFouten: (mailbox.alleVerbindingsFouten ? mailbox.alleVerbindingsFouten() : [])
      .filter((f) => f.mailbox !== (settingsStore.getConfig().imapUser || "")),
  });
});

// Test of je mailgegevens aanvaard worden. Kan met de bewaarde instellingen, of
// met wat je op dat moment in het scherm hebt staan — zodat je een nieuw
// wachtwoord kan uitproberen zonder het eerst te moeten opslaan.
app.post("/api/mail/test", async (req, res) => {
  try {
    const b = req.body || {};
    const huidig = settingsStore.getConfig();
    const proef = {
      imapHost: b.imapHost || huidig.imapHost,
      imapPort: b.imapPort || huidig.imapPort,
      imapUser: b.imapUser || huidig.imapUser,
      imapPassword: (b.imapPassword && b.imapPassword.trim()) ? b.imapPassword.trim() : huidig.imapPassword,
    };
    const uitslag = await mailbox.testAanmelden(proef);
    res.json(uitslag);
  } catch (e) {
    res.status(500).json({ ok: false, uitleg: "De test kon niet uitgevoerd worden: " + e.message });
  }
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

async function haalMailOp(accountKey, uid, folder, volledig) {
  const map = folder || "INBOX";
  const bewaard = mailstore.getBody(accountKey, map, uid);
  // JOU NOOIT LATEN WACHTEN.
  // Van grote mails halen we bij het inladen alleen het begin op — de tekst,
  // niet de bijlagen. Vroeger ging Mailvio zo'n mail bij het OPENEN alsnog
  // volledig van je mailserver halen, en dan stond jij tien seconden te kijken.
  // Nu krijg je meteen wat er is, en wordt de rest achter je rug bijgehaald.
  // De volgende keer staat ze compleet klaar, en een bijlage werkt sowieso —
  // die wordt apart opgehaald als je erop klikt.
  if (leesbaar(bewaard)) {
    if (volledig && bewaard.afgekapt && !haalMailOp._bezig.has(uid)) {
      haalMailOp._bezig.add(uid);
      (async () => {
        try {
          const heel = await mailbox.fetchMailBody(uid, map === "INBOX" ? undefined : map);
          if (leesbaar(heel)) mailstore.bewaarBody(accountKey, map, uid, heel);
        } catch (e) { /* volgende keer opnieuw */ }
        finally { haalMailOp._bezig.delete(uid); }
      })();
    }
    return bewaard;
  }
  if (bewaard && (bewaard.leegPogingen || 0) >= LEEG_MAX) return bewaard;
  const body = await mailbox.fetchMailBody(uid, map === "INBOX" ? undefined : map);
  bewaarInhoud(accountKey, map, uid, body, bewaard);
  return body || bewaard;
}
// Welke mails er op dit moment op de achtergrond volledig opgehaald worden.
haalMailOp._bezig = new Set();

app.get("/api/mails/:uid", async (req, res) => {
  try {
    const uid = Number(req.params.uid);
    const folder = req.query.folder;
    const accountKey = settingsStore.getConfig().imapUser || "default";

    // Mail uit een andere map: geen AI-gegevens, gewoon de inhoud tonen.
    if (folder && folder !== "INBOX") {
      const body = await haalMailOp(accountKey, uid, folder, true);
      if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
      return res.json(body);
    }
    const body = await haalMailOp(accountKey, uid, "INBOX", true);
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
    const accountKey = settingsStore.getConfig().imapUser || "default";
    if (!opnieuw && suggestionCache.has(uid)) {
      return res.json(suggestionCache.get(uid));
    }
    // OP SCHIJF BEWAARD. Tot nu stond een voorstel enkel in het geheugen en werd
    // het bij elke verversing weggegooid — dus zat je telkens opnieuw te wachten.
    if (!opnieuw) {
      const bewaardVoorstel = voorstellen.get(accountKey, uid);
      if (bewaardVoorstel) {
        suggestionCache.set(uid, bewaardVoorstel);
        return res.json(bewaardVoorstel);
      }
    }
    const data = await getMails(false);
    const meta = data.mails.find((m) => m.uid === uid) || {};
    // Uit de bewaarde inhoud, niet opnieuw van de mailserver — dat scheelde
    // seconden per mail.
    const body = await haalMailOp(accountKey, uid, "INBOX");
    if (!body) return res.status(404).json({ error: "Mail niet gevonden." });
    const suggestion = await ai.suggestReply({ ...meta, ...body }, { snel: !opnieuw });
    suggestionCache.set(uid, suggestion);
    voorstellen.bewaar(accountKey, uid, suggestion);
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
    // "prullenmand" en "archief" zijn rollen; "map:Naam" is een echte map op je
    // mailserver, zodat je vanuit het rechtsklikmenu overal naartoe kan.
    const gevraagd = String(req.body?.to || "");
    const doel = gevraagd.startsWith("map:") ? gevraagd
      : gevraagd === "prullenmand" ? "prullenmand"
      : gevraagd === "reclame" ? "map:Reclame"
      : "archief";
    const folder = req.body?.folder;
    const result = await mailbox.verplaatsMail(uid, doel, folder);
    // NAAR RECLAME GESLEEPT = VOORTAAN ALTIJD RECLAME.
    // Zet je een mail zelf bij de reclame, dan is dat een oordeel over die
    // afzender. Dat onthouden we, zodat je het geen tweede keer hoeft te doen.
    if (/reclame|junk|spam|ongewenst/i.test(doel)) {
      const bron = (cache.mails || []).find((m) => m.uid === uid) || (envelopeCache.mails || []).find((m) => m.uid === uid);
      const adres = bron && bron.fromAddress;
      if (adres) {
        afzenders.beslis(taakAccount(), adres, true);
        console.log(`${adres} voortaan als reclame behandeld (mail zelf verplaatst).`);
      }
    }
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
// Automatische meldingen die nooit een antwoord vroegen: pas na een jaar.
const OPRUIM_MELDING_DAGEN = 365;
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

    // MEER MAG WEG, MAAR ALLEEN WAT ECHT VEILIG IS.
    // Een gewone mail van vier jaar geleden kan nog altijd een offerte of een
    // garantie zijn — die blijft. Maar deze twee soorten kan je gerust missen:

    // 1. Phishing. Die hoef je niet te bewaren, hoe oud ook.
    if (m.soort === "phishing" && !openZaak) {
      voorstellen.push({ ...m, reden: "Vermoedelijke oplichting — die hoef je niet te bewaren.", groep: "phishing" });
      continue;
    }

    // 2. Automatische meldingen die niets vragen en waar je nooit iets mee
    //    gedaan hebt: bevestigingen, "je documenten staan klaar", nieuwsbrieven
    //    zonder vraag. Enkel als ze ouder zijn dan een jaar én afgehandeld of
    //    nooit een actie waren.
    const geenActie = !openZaak && m.antwoordNodig === false && !m.aanvraag;
    if (geenActie && ouderdom > OPRUIM_MELDING_DAGEN && m.vanType !== "klant" && m.soort !== "offerte" && m.soort !== "factuur") {
      voorstellen.push({
        ...m,
        reden: `Automatische melding van ${Math.round(ouderdom / 30)} maanden oud die geen antwoord vroeg.`,
        groep: "melding",
      });
      continue;
    }
  }
  // Nieuwste eerst; in het scherm kan je omdraaien naar oudste eerst.
  voorstellen.sort((a, b) => new Date(b.date) - new Date(a.date));
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
      // Er is echt een antwoord vertrokken — dat is meer dan "afgevinkt".
      classifications.setBeantwoord(accountKey, uid);
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

// ---------------------------------------------------------------------------
// MAILS DIE VANZELF NAAR EEN MAP MOETEN
// ---------------------------------------------------------------------------
// Heb je een eigen regel met de actie "verplaats naar map" — bijvoorbeeld
// "alles van LUCY naar Boekhouding" — dan gebeurt dat hier, op de achtergrond.
// Bewust NIET op het moment dat je je mails opvraagt: dan zou er met je
// mailserver gepraat worden terwijl jij op je scherm staat te wachten.
// Hoogstens een handvol per ronde, zodat je mailserver niet overbelast raakt.
const VERPLAATS_PER_RONDE = 15;
const alVerplaatst = new Set();

async function verplaatsVolgensRegels(accountKey) {
  const overzichtRegels = regels.overzicht(accountKey);
  const verhuisRegels = (overzichtRegels.eigen || []).filter((r) => r.aan && (r.acties || []).includes("verplaats") && r.map);
  if (!verhuisRegels.length) return;

  const mails = mailstore.getMails(accountKey, "INBOX").slice(0, 400);
  const store = classifications.getAll(accountKey);
  let gedaan = 0;
  for (const m of mails) {
    if (gedaan >= VERPLAATS_PER_RONDE) break;
    if (alVerplaatst.has(m.uid)) continue;
    const c = store[m.uid] || {};
    const beoordeling = { soort: c.soort || "overig", categorie: c.categorie || "", belangrijk: !!c.belangrijk };
    regels.pasToe(accountKey, { ...m, snippet: c.snippet || m.snippet }, beoordeling);
    if (!beoordeling.verplaatsNaar) continue;
    try {
      await mailbox.verplaatsMail(m.uid, beoordeling.verplaatsNaar, "INBOX");
      alVerplaatst.add(m.uid);
      gedaan++;
      console.log(`Mail ${m.uid} vanzelf naar "${beoordeling.verplaatsNaar}" verplaatst.`);
    } catch (e) {
      // Lukt het niet, dan proberen we het gewoon de volgende ronde opnieuw —
      // maar we blijven er niet in vastzitten.
      alVerplaatst.add(m.uid);
      console.error(`Kon mail ${m.uid} niet verplaatsen:`, mailbox.leesbareImapFout(e));
    }
    await mailbox.wachtOpRust();
  }
  if (gedaan) {
    cache.at = 0;
    envelopeCache = { at: 0, mails: [], total: 0, capped: false };
  }
}

async function achtergrondRonde() {
  if (achtergrondBezig) return;
  if (!mailbox.isConfigured()) return;
  // Loopt de server al achter op zichzelf? Dan is dit geen moment om er werk
  // bij te nemen. We komen straks gewoon terug.
  if (belasting.drukbezet() || belasting.afgeknepen()) {
    console.log("Achtergrondronde overgeslagen: de server heeft het te druk.");
    return;
  }
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
      console.error("Inbox volledig binnenhalen mislukt:", mailbox.leesbareImapFout(e));
    }
    cache.at = 0;
    envelopeCache = { at: 0, mails: [], total: 0, capped: false };
    await getMails(true);

    // Je mappen worden NIET meer hier binnengehaald. Ze hebben hun eigen ritme
    // (zie mapBeurt verderop), zodat Verzonden en Prullenmand er meteen staan
    // in plaats van achter het beoordelen van honderden mails te moeten wachten.

    // Dan de achterstand van de AI-beoordeling wegwerken, portie per portie.
    // Dit gebeurt hier, op de achtergrond, en niet terwijl jij op je scherm wacht.
    for (let ronde = 0; ronde < 25; ronde++) {
      // Ook hier: enkel je recentste post beoordelen. Een oordeel over een mail
      // van drie jaar geleden kost geld en levert niets op.
      const licht = mailstore.getMails(accountKey0, "INBOX").slice(0, BEOORDEEL_MAX_MAILS);
      const grensOud = Date.now() - BEOORDEEL_MAX_OUD_MS;
      const store = classifications.getAll(accountKey0);
      const teDoen = licht.filter((m) => {
        const t = m.date ? Date.parse(m.date) : 0;
        if (Number.isFinite(t) && t < grensOud) return false;
        const c = store[m.uid];
        if (!c) return true;
        if ((c.pogingen || 0) >= 3) return false;
        return c.categorie === undefined || c.categorie === "onbekend";
      });
      if (!teDoen.length) break;
      // En stoppen zodra de daggrens voor je tegoed bereikt is.
      if (!tegoed.magNog()) {
        console.log("Daggrens voor het AI-tegoed bereikt — beoordelen gaat morgen verder.");
        break;
      }
      await beoordeelPortie(accountKey0, teDoen);
      // Blijft het mislukken (bv. een sleutel die niet aanvaard wordt), dan
      // stoppen we deze ronde in plaats van 25 keer dezelfde fout te maken.
      if (ai.getLaatsteFout()) break;
    }
    cache.at = 0;

    // Mailtjes die je naar jezelf stuurde, op je to-dolijst zetten.
    try {
      eigenMailsNaarTaken(accountKey0, (await getMails(false)).mails || []);
    } catch (e) {
      console.error("Eigen mails naar to-do zetten mislukt:", e.message);
    }

    // Mails die volgens jouw eigen regels naar een map moeten (bijvoorbeeld
    // alles van de boekhouding naar je boekhoudmap) worden hier verplaatst.
    try {
      await verplaatsVolgensRegels(accountKey0);
    } catch (e) {
      console.error("Automatisch verplaatsen mislukt:", mailbox.leesbareImapFout(e));
    }

    // Het klaarzetten van de antwoorden gebeurt NIET meer hier. Het stond
    // achteraan deze ronde en kwam daardoor amper aan de beurt. Het heeft nu
    // zijn eigen ritme, verderop in dit bestand.

    // Het inladen van de mailinhoud gebeurt NIET meer hier. Het stond helemaal
    // achteraan deze ronde, achter het binnenhalen van alle mappen en het
    // beoordelen van honderden mails — en kwam daardoor amper aan de beurt.
    // Het heeft nu zijn eigen ritme, verderop in dit bestand.

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
      for (const f of mappenVoorAchtergrond(mappen)) {
        if (!f.path || f.path.toUpperCase() === "INBOX") continue;
        if (mapBezig.has(f.path)) continue;
        mapBezig.add(f.path);
        try {
          await syncMap(accountKey, f.path, { totVolledig: true });
        } catch (e) {
          console.error(`Map ${f.path} bijwerken mislukt:`, mailbox.leesbareImapFout(e));
        } finally {
          mapBezig.delete(f.path);
        }
      }
    } catch (e) {
      console.error("Mappen bijwerken mislukt:", mailbox.leesbareImapFout(e));
    }
  } catch (e) {
    console.error("Achtergrondronde mislukt (wordt straks opnieuw geprobeerd):", e.message);
  } finally {
    achtergrondBezig = false;
    belasting.zetBezig("niets");
  }
}

setTimeout(() => {
  achtergrondRonde();
  setInterval(achtergrondRonde, ACHTERGROND_MS);
}, EERSTE_START_MS);

// ---------------------------------------------------------------------------
// JE MAPPEN STAAN ER METEEN
// ---------------------------------------------------------------------------
// Verzonden, Concepten, Archief, Prullenmand en Ongewenst werden pas
// binnengehaald aan het EIND van de grote achtergrondronde — achter het
// bijwerken van de inbox en het beoordelen van honderden mails aan. In de
// praktijk kwam dat amper aan de beurt, en dus stond je te wachten zodra je op
// Verzonden klikte.
// Nu halen ze zichzelf binnen, vlak na het opstarten, één map per beurt, en ze
// gaan vanzelf opzij zodra jij iets doet. Wat één keer binnen is, blijft staan.
const MAP_INTERVAL_MS = 20000;
const MAP_ROLLEN_EERST = ["verzonden", "concepten", "archief", "prullenmand", "spam"];
let mapBeurtBezig = false;

async function mapBeurt() {
  if (mapBeurtBezig || !mailbox.isConfigured()) return;
  if (belasting.afgeknepen()) return;
  mapBeurtBezig = true;
  try {
    const accountKey = settingsStore.getConfig().imapUser || "default";
    let mappen = folderCache.folders;
    if (!mappen.length) {
      belasting.zetBezig("mappenlijst ophalen");
      const data = await mailbox.listFolders();
      mappen = data.folders || [];
      if (mappen.length) folderCache = { at: Date.now(), folders: mappen };
    }

    // Eerst je standaardmappen, in de volgorde waarin je ze gebruikt.
    const teDoen = mappen
      .filter((f) => f.path && f.path.toUpperCase() !== "INBOX")
      .filter((f) => MAP_ROLLEN_EERST.includes(f.rol))
      .sort((a, b) => MAP_ROLLEN_EERST.indexOf(a.rol) - MAP_ROLLEN_EERST.indexOf(b.rol));

    for (const f of teDoen) {
      if (mapBezig.has(f.path)) continue;
      // Nog nooit opgehaald, of nog niet volledig? Dan is die aan de beurt.
      const heeftAl = mailstore.getMails(accountKey, f.path).length;
      const volledig = mailstore.isVolledig(accountKey, f.path);
      if (heeftAl && volledig) continue;

      await mailbox.wachtOpRust();
      await belasting.wachtOpRust();
      if (mailbox.gebruikerBezig() || belasting.afgeknepen()) break;

      mapBezig.add(f.path);
      belasting.zetBezig(`map ${f.path} binnenhalen`);
      try {
        await syncMap(accountKey, f.path, { totVolledig: true });
        console.log(`Map ${f.path} staat klaar (${mailstore.getMails(accountKey, f.path).length} berichten).`);
      } catch (e) {
        console.error(`Map ${f.path} binnenhalen mislukt:`, mailbox.leesbareImapFout(e));
      } finally {
        mapBezig.delete(f.path);
      }
      break; // één map per beurt: zo blijft de app ondertussen vlot
    }
  } catch (e) {
    console.error("Mappen binnenhalen mislukt:", mailbox.leesbareImapFout(e));
  } finally {
    mapBeurtBezig = false;
    belasting.zetBezig("niets");
  }
}

setTimeout(() => {
  mapBeurt();
  setInterval(mapBeurt, MAP_INTERVAL_MS);
}, EERSTE_START_MS + 2000);

// ---------------------------------------------------------------------------
// HET INLADEN VAN DE MAILINHOUD HEEFT ZIJN EIGEN RITME
// ---------------------------------------------------------------------------
// Dit liep vroeger mee in de grote ronde, helemaal achteraan: eerst alle mappen
// binnenhalen, dan honderden mails laten beoordelen, en dán pas de inhoud. In de
// praktijk kwam het amper aan de beurt — na uren draaien stond er 6% van je
// mails ingeladen. Nu loopt het los daarvan, in korte beurten, en het wijkt
// vanzelf zodra jij iets doet.
const INLAAD_INTERVAL_MS = 15000;
const INLAAD_PORTIES = 20;

async function inlaadBeurt() {
  if (!mailbox.isConfigured()) return;
  const accountKey = settingsStore.getConfig().imapUser || "default";
  // GAS TERUGNEMEN ALS DE MACHINE AFGEKNEPEN WORDT.
  // Je server deelt zijn processor met anderen. Werkt Mailvio te lang aan één
  // stuk door, dan knijpt Fly de machine af en staat ALLES seconden stil — ook
  // jouw klik. Dat voelen we aan onze eigen klok, en dan doen we het rustiger
  // aan. Het inladen duurt dan wat langer, maar je app blijft bruikbaar.
  const porties = belasting.afgeknepen() ? 2 : INLAAD_PORTIES;
  if (belasting.afgeknepen()) {
    console.log(`Machine wordt afgeknepen (${Math.round(belasting.recenteBlokkade() / 100) / 10}s stil) — rustiger inladen.`);
  }
  try {
    await laadVoorafIn(accountKey, porties);
  } catch (e) {
    console.error("Inladen op de achtergrond mislukt:", e.message);
  }
}

setTimeout(() => {
  inlaadBeurt();
  setInterval(inlaadBeurt, INLAAD_INTERVAL_MS);
}, EERSTE_START_MS + 5000);

// ---------------------------------------------------------------------------
// HET VOORGESTELDE ANTWOORD HEEFT OOK ZIJN EIGEN RITME
// ---------------------------------------------------------------------------
// Dit is waar het om draait: als jij een mail opent, moet er AL staan wat er
// moet gebeuren, hoe dringend het is, en een antwoord dat je kan versturen.
// Niet pas beginnen rekenen op het moment dat jij zit te kijken.
// Het klaarzetten liep tot nu mee achteraan de grote ronde en kwam daardoor
// amper aan de beurt. Nu draait het apart, elke halve minuut, en het wijkt
// vanzelf zodra jij iets doet.
const VOORSTEL_INTERVAL_MS = 30000;

async function voorstelBeurt() {
  if (!mailbox.isConfigured() || !ai.isConfigured()) return;
  if (belasting.afgeknepen()) return;
  // DE REM OP JE TEGOED. Antwoorden klaarzetten kost geld. Is de daggrens
  // bereikt, dan stopt het werk op de achtergrond tot morgen. Wat JIJ zelf
  // aanklikt gaat altijd door.
  if (!tegoed.magNog()) return;
  const accountKey = settingsStore.getConfig().imapUser || "default";
  try {
    await maakVoorstellenKlaar(accountKey);
  } catch (e) {
    console.error("Antwoorden klaarzetten mislukt:", e.message);
  }
}

setTimeout(() => {
  voorstelBeurt();
  setInterval(voorstelBeurt, VOORSTEL_INTERVAL_MS);
}, EERSTE_START_MS + 12000);

// Laatste vangnet: een onvoorziene fout mag Mailvio nooit helemaal platleggen.
// Beter een gelogde fout en een app die blijft draaien, dan een mailbox die
// plots onbereikbaar is.
process.on("uncaughtException", (err) => {
  console.error("Onverwachte fout (app blijft draaien):", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reden) => {
  console.error("Onafgehandelde belofte (app blijft draaien):", reden);
});

// DE MAILS ALVAST INLEZEN VOOR WE OPENGAAN.
// De eerste keer dat er iets uit de bewaarde mailbox nodig is, moet dat bestand
// van schijf gelezen worden — bij duizenden mails duurt dat ruim een seconde.
// Gebeurde dat tijdens jouw eerste klik, dan wachtte jij daarop. Nu gebeurt het
// hier, terwijl de server toch nog aan het opstarten is.
try {
  const startAccount = settingsStore.getConfig().imapUser || "default";
  const t0 = Date.now();
  const aantal = mailstore.getMails(startAccount, "INBOX").length;
  if (aantal) console.log(`${aantal} bewaarde mails ingelezen in ${Date.now() - t0}ms.`);
} catch (e) {
  console.error("Bewaarde mails vooraf inlezen mislukt:", e.message);
}

app.listen(PORT, () => {
  console.log(`Mailvio draait op poort ${PORT}`);
});
