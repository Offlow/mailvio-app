// classifications.js — houdt de AI-beoordeling (categorie/reden/vanType/actieLabel)
// en het opgehaalde fragment per mail (uid) PERMANENT bij op schijf, per mailaccount.
// Zo moet een mail maar één keer gescand worden — ook na een herstart of herdeploy
// (zolang de "data"-map bewaard blijft, bv. via een Fly.io Volume).
const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "data", "classifications.json");

// DE BEOORDELINGEN BLIJVEN IN HET GEHEUGEN STAAN.
// Net als bij de mails werd dit bestand bij ELKE opvraging opnieuw van schijf
// gelezen en ontleed — en dat gebeurt tientallen keren per aanvraag. Zolang dat
// bezig is staat de hele server stil. Nu wordt het één keer gelezen; het
// wegschrijven gebeurt achter je rug, hoogstens één keer per seconde.
let _store = null;
let _schrijfTimer = null;

function readStore() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (e) {
    _store = {};
  }
  return _store;
}

function naarSchijf() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Via een tijdelijk bestand, zodat een herstart middenin nooit een half
    // bestand achterlaat en al je beoordelingen weg zijn.
    fs.writeFileSync(STORE_FILE + ".tmp", JSON.stringify(_store || {}), "utf8");
    fs.renameSync(STORE_FILE + ".tmp", STORE_FILE);
  } catch (e) {
    console.error("Kon de beoordelingen niet wegschrijven:", e.message);
  }
}

function writeStore(store) {
  _store = store;
  if (_schrijfTimer) return;
  _schrijfTimer = setTimeout(() => { _schrijfTimer = null; naarSchijf(); }, 1000);
  if (_schrijfTimer.unref) _schrijfTimer.unref();
}

function flush() {
  if (_schrijfTimer) { clearTimeout(_schrijfTimer); _schrijfTimer = null; }
  if (_store) naarSchijf();
}
for (const sein of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sein, () => { flush(); if (sein !== "exit") process.exit(0); });
}

// Alles wordt genest onder de accountsleutel (het IMAP-mailadres) zodat een
// latere koppeling met een ANDER mailaccount nooit per ongeluk de labels van
// een vorig account overneemt (mail-uid's zijn enkel uniek binnen één mailbox).
function getAll(accountKey) {
  const store = readStore();
  return store[accountKey] || {};
}

function setMany(accountKey, entries) {
  if (!accountKey || !entries.length) return;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  for (const e of entries) {
    // Behoud een eventueel al gezette "afgehandeld"-status (setResolved kan al
    // gebeurd zijn vóór de AI-classificatie klaar was) — nooit overschrijven.
    const existing = forAccount[e.uid] || {};
    forAccount[e.uid] = {
      ...existing,
      categorie: e.categorie,
      reden: e.reden || "",
      vanType: e.vanType || "onbekend",
      actieLabel: e.actieLabel || "",
      soort: e.soort || "overig",
      belangrijk: !!e.belangrijk,
      viaWebsite: !!e.viaWebsite,
      reclameTwijfel: !!e.reclameTwijfel,
      // Is dit nieuw werk dat aan hem gericht is, en zit er iemand op een
      // antwoord te wachten? De AI beslist dat mee in dezelfde oproep, dus het
      // kost geen extra tegoed.
      // Bewust NIET altijd op false zetten: mails die vroeger beoordeeld zijn
      // kennen dit veld nog niet, en die willen we niet in één klap allemaal
      // uit je aanvragenlijst gooien. Onbekend blijft onbekend, en daar geldt
      // dan de strenge vuistregel.
      aanvraag: e.aanvraag === undefined ? existing.aanvraag : !!e.aanvraag,
      antwoordNodig: e.antwoordNodig === undefined ? existing.antwoordNodig : !!e.antwoordNodig,
      snippet: e.snippet || "",
      classifiedAt: Date.now(),
      // Hoe vaak we al geprobeerd hebben. Lukt het na een paar pogingen nog
      // altijd niet, dan laten we die mail met rust in plaats van hem elke
      // ronde opnieuw door de AI te sturen — dat kost tegoed en tijd zonder
      // dat er ooit iets uitkomt.
      pogingen: (existing.pogingen || 0) + 1,
    };
  }
  store[accountKey] = forAccount;
  writeStore(store);
}

// Markeert een mail expliciet als afgehandeld/niet-afgehandeld. Dit gebeurt
// ENKEL op vraag van de gebruiker (knop "Afgehandeld") of automatisch nadat
// er via Mailvio effectief op geantwoord is — nooit door een herscan, een
// cache-ververs of het verstrijken van tijd. Zo verdwijnt een openstaande
// zaak nooit uit zichzelf.
// Je hebt er ECHT op geantwoord — via Mailvio verstuurd. Dat is iets anders dan
// "afgevinkt": afvinken zegt "hier moet ik niets meer mee", beantwoorden zegt
// "er is een antwoord vertrokken". Dat verschil wil je op je scherm zien.
function setBeantwoord(accountKey, uid) {
  if (!accountKey) return null;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  const existing = forAccount[uid] || {};
  const entry = { ...existing, beantwoord: true, beantwoordOp: Date.now(), resolved: true, resolvedAt: existing.resolvedAt || Date.now() };
  forAccount[uid] = entry;
  store[accountKey] = forAccount;
  writeStore(store);
  return entry;
}

function setResolved(accountKey, uid, resolved) {
  if (!accountKey) return null;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  const existing = forAccount[uid] || {};
  const entry = { ...existing, resolved: !!resolved, resolvedAt: resolved ? Date.now() : null };
  forAccount[uid] = entry;
  store[accountKey] = forAccount;
  writeStore(store);
  return entry;
}

// "Niet meer opvolgen": de mail blijft gewoon in je mailbox staan, maar
// Mailvio houdt er geen openstaande zaak meer van bij. Je hoeft er dus niet
// meer op te antwoorden en hij komt niet meer terug op je dashboard.
function setGenegeerd(accountKey, uid, genegeerd) {
  if (!accountKey) return null;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  const existing = forAccount[uid] || {};
  const entry = { ...existing, genegeerd: !!genegeerd, resolved: genegeerd ? true : existing.resolved };
  forAccount[uid] = entry;
  store[accountKey] = forAccount;
  writeStore(store);
  return entry;
}

// Wist enkel het OORDEEL van de AI. Wat JIJ zelf besliste — afgehandeld,
// niet meer opvolgen — blijft staan. Zo kan je de mailbox opnieuw laten
// beoordelen zonder je eigen werk kwijt te spelen.
function wisBeoordelingen(accountKey) {
  const store = readStore();
  const forAccount = store[accountKey] || {};
  let aantal = 0;
  for (const uid of Object.keys(forAccount)) {
    const e = forAccount[uid];
    const bewaard = { resolved: e.resolved, resolvedAt: e.resolvedAt, genegeerd: e.genegeerd, beantwoord: e.beantwoord, beantwoordOp: e.beantwoordOp };
    forAccount[uid] = Object.fromEntries(Object.entries(bewaard).filter(([, v]) => v !== undefined));
    aantal++;
  }
  store[accountKey] = forAccount;
  writeStore(store);
  return aantal;
}

// Telt een mislukte poging voor mails waar de AI niets over teruggaf. Zonder
// dit zouden die eeuwig opnieuw aangeboden worden.
function telPoging(accountKey, uids) {
  if (!accountKey || !uids.length) return;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  for (const uid of uids) {
    const e = forAccount[uid] || {};
    // Nooit hoger dan 3 tellen. Twee achtergrondtaken kunnen dezelfde mail
    // net na elkaar proberen; zonder deze grens staat er dan 4 of 5.
    forAccount[uid] = { ...e, pogingen: Math.min(3, (e.pogingen || 0) + 1) };
  }
  store[accountKey] = forAccount;
  writeStore(store);
}

module.exports = { flush, getAll, setMany, setBeantwoord, setResolved, setGenegeerd, wisBeoordelingen, telPoging };
