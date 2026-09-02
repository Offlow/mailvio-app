// mailstore.js — bewaart je mails lokaal op de persistente schijf, zodat
// Mailvio niet elke keer je hele mailbox opnieuw van de server moet halen.
//
// Werkt zoals Outlook of Apple Mail: wat één keer opgehaald is, blijft staan.
// Bij het openen toont Mailvio meteen wat het al heeft, en haalt daarna enkel
// de NIEUWE berichten op. Oude mails zijn dus ook direct beschikbaar.
//
// Per mailbox (account) en per map wordt bijgehouden:
//   uidValidity  — verandert de mailserver dit, dan kloppen de oude nummers
//                  niet meer en beginnen we opnieuw (zeldzaam, maar het
//                  gebeurt bv. bij een migratie bij je provider).
//   mails        — de kopregels per uid (van, onderwerp, datum, gelezen, ...)
//   bodies       — de inhoud van mails die je al geopend hebt
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const CACHE_DIR = path.join(DATA_DIR, "mailcache");

// Hoeveel geopende mails we bewaren per mailbox. Een mail met bijlagen kan
// groot zijn; dit houdt de schijf binnen de perken.
// Nu elke mail in een eigen bestand staat, kunnen we er veel meer bewaren
// zonder dat het de app vertraagt.
const MAX_BEWAARDE_BERICHTEN = 25000;

function veiligeNaam(tekst) {
  return String(tekst || "onbekend").replace(/[^a-zA-Z0-9._@-]/g, "_").slice(0, 120);
}

function bestandVoor(accountKey, folder) {
  return path.join(CACHE_DIR, `${veiligeNaam(accountKey)}__${veiligeNaam(folder)}.json`);
}

function lees(accountKey, folder) {
  try {
    return JSON.parse(fs.readFileSync(bestandVoor(accountKey, folder), "utf8"));
  } catch (e) {
    return { uidValidity: null, mails: {}, bodies: {}, bijgewerkt: 0 };
  }
}

function schrijf(accountKey, folder, data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(bestandVoor(accountKey, folder), JSON.stringify(data), "utf8");
  } catch (e) {
    console.error("Kon de mailcache niet wegschrijven:", e.message);
  }
}

// Alle bewaarde mails van een map, nieuwste eerst.
function getMails(accountKey, folder) {
  const data = lees(accountKey, folder);
  return Object.values(data.mails || {}).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getUidValidity(accountKey, folder) {
  return lees(accountKey, folder).uidValidity;
}

// Het hoogste uid dat we al kennen — alles daarboven is nieuw op de server.
function getHoogsteUid(accountKey, folder) {
  const data = lees(accountKey, folder);
  const uids = Object.keys(data.mails || {}).map(Number).filter((n) => !isNaN(n));
  return uids.length ? Math.max(...uids) : 0;
}

// Het laagste uid dat we hebben — alles daaronder moet nog opgehaald worden.
function getLaagsteUid(accountKey, folder) {
  const data = lees(accountKey, folder);
  const uids = Object.keys(data.mails || {}).map(Number).filter((n) => !isNaN(n));
  return uids.length ? Math.min(...uids) : 0;
}

// Onthoudt of we al helemaal tot bij de oudste mail geraakt zijn, zodat we
// niet elke keer opnieuw naar oudere berichten blijven zoeken.
function isVolledig(accountKey, folder) {
  return !!lees(accountKey, folder).volledig;
}

function markeerVolledig(accountKey, folder) {
  const data = lees(accountKey, folder);
  data.volledig = true;
  schrijf(accountKey, folder, data);
}

// Nieuwe of bijgewerkte kopregels bewaren.
function bewaarMails(accountKey, folder, mails, uidValidity) {
  if (!accountKey || !mails || !mails.length) return;
  const data = lees(accountKey, folder);
  if (uidValidity !== undefined && uidValidity !== null) data.uidValidity = uidValidity;
  for (const m of mails) {
    const bestaand = data.mails[m.uid] || {};
    data.mails[m.uid] = { ...bestaand, ...m };
  }
  data.bijgewerkt = Date.now();
  schrijf(accountKey, folder, data);
}

// Eén veld bijwerken (bv. gelezen/ongelezen) zonder de rest aan te raken.
function werkBij(accountKey, folder, uid, velden) {
  const data = lees(accountKey, folder);
  if (!data.mails[uid]) return;
  data.mails[uid] = { ...data.mails[uid], ...velden };
  schrijf(accountKey, folder, data);
}

// Mails die op de server niet meer bestaan (verplaatst of verwijderd) ook
// hier weghalen, zodat je lijst klopt.
function verwijderOntbrekende(accountKey, folder, bestaandeUids) {
  const data = lees(accountKey, folder);
  const houden = new Set(bestaandeUids.map(Number));
  let gewijzigd = false;
  for (const uid of Object.keys(data.mails)) {
    if (!houden.has(Number(uid))) {
      delete data.mails[uid];
      delete data.bodies[uid];
      gewijzigd = true;
    }
  }
  if (gewijzigd) schrijf(accountKey, folder, data);
  return gewijzigd;
}

function verwijderMail(accountKey, folder, uid) {
  const data = lees(accountKey, folder);
  delete data.mails[uid];
  delete data.bodies[uid];
  try { fs.unlinkSync(inhoudBestand(accountKey, folder, uid)); } catch (e) { /* niet bewaard */ }
  schrijf(accountKey, folder, data);
}

// ---------------------------------------------------------------------------
// De inhoud van mails — ELK IN EEN EIGEN BESTAND
// ---------------------------------------------------------------------------
// Bewust NIET samen met de kopregels in één groot bestand. Een mail met
// bijlagen is al gauw enkele megabytes; honderden daarvan in één JSON-bestand
// betekent dat de server dat hele bestand moet inlezen en wegschrijven telkens
// er ook maar één mail bijkomt. Dat maakt de app trager naarmate je hem meer
// gebruikt — precies het omgekeerde van wat je wil.
// Eén bestand per mail: openen en bewaren blijft even snel, of je er nu tien of
// duizend hebt.
const INHOUD_DIR = path.join(CACHE_DIR, "inhoud");

function inhoudBestand(accountKey, folder, uid) {
  return path.join(INHOUD_DIR, `${veiligeNaam(accountKey)}__${veiligeNaam(folder)}__${veiligeNaam(String(uid))}.json`);
}

function bewaarBody(accountKey, folder, uid, body) {
  try {
    if (!fs.existsSync(INHOUD_DIR)) fs.mkdirSync(INHOUD_DIR, { recursive: true });
    fs.writeFileSync(inhoudBestand(accountKey, folder, uid), JSON.stringify({ ...body, bewaardOp: Date.now() }), "utf8");
  } catch (e) {
    console.error("Mailinhoud bewaren mislukt:", e.message);
  }
  ruimInhoudOp(accountKey);
}

function getBody(accountKey, folder, uid) {
  try {
    return JSON.parse(fs.readFileSync(inhoudBestand(accountKey, folder, uid), "utf8"));
  } catch (e) {
    return null;
  }
}

// Niet oneindig laten aangroeien: de oudst bewaarde inhoud valt weg zodra we
// boven de grens komen. De mail zelf blijft gewoon in je mailbox staan; enkel
// de bewaarde kopie verdwijnt en wordt bij het openen opnieuw gehaald.
let laatsteOpruim = 0;
function ruimInhoudOp(accountKey) {
  // Hoogstens één keer per minuut, anders kost het opruimen zelf tijd.
  if (Date.now() - laatsteOpruim < 60000) return;
  laatsteOpruim = Date.now();
  try {
    const voorvoegsel = veiligeNaam(accountKey) + "__";
    const bestanden = fs.readdirSync(INHOUD_DIR)
      .filter((n) => n.startsWith(voorvoegsel))
      .map((n) => {
        const pad = path.join(INHOUD_DIR, n);
        let tijd = 0;
        try { tijd = fs.statSync(pad).mtimeMs; } catch (e) { /* weg is weg */ }
        return { pad, tijd };
      });
    if (bestanden.length <= MAX_BEWAARDE_BERICHTEN) return;
    bestanden.sort((a, b) => a.tijd - b.tijd);
    for (const b of bestanden.slice(0, bestanden.length - MAX_BEWAARDE_BERICHTEN)) {
      try { fs.unlinkSync(b.pad); } catch (e) { /* al weg */ }
    }
  } catch (e) { /* map bestaat nog niet */ }
}

// Alles van een map weggooien — bij een uidValidity-wissel of als de
// gebruiker opnieuw wil beginnen.
function wisMap(accountKey, folder) {
  try {
    fs.unlinkSync(bestandVoor(accountKey, folder));
  } catch (e) { /* bestond nog niet */ }
}

function statistiek(accountKey, folder) {
  const data = lees(accountKey, folder);
  return {
    aantal: Object.keys(data.mails || {}).length,
    bewaardeBerichten: Object.keys(data.bodies || {}).length,
    bijgewerkt: data.bijgewerkt || 0,
  };
}

// Alle mappen waarvan we mails bewaard hebben. Nodig om over de hele bewaarde
// mailbox te kunnen zoeken zonder de mailserver lastig te vallen.
function getMappen(accountKey) {
  try {
    const voorvoegsel = veiligeNaam(accountKey) + "__";
    return fs.readdirSync(CACHE_DIR)
      .filter((naam) => naam.startsWith(voorvoegsel) && naam.endsWith(".json"))
      .map((naam) => naam.slice(voorvoegsel.length, -5));
  } catch (e) {
    return [];
  }
}

module.exports = {
  getMappen,
  getMails,
  getUidValidity,
  getHoogsteUid,
  getLaagsteUid,
  isVolledig,
  markeerVolledig,
  bewaarMails,
  werkBij,
  verwijderOntbrekende,
  verwijderMail,
  bewaarBody,
  getBody,
  wisMap,
  statistiek,
};
