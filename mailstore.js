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
const MAX_BEWAARDE_BERICHTEN = 400;

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
  schrijf(accountKey, folder, data);
}

// De inhoud van een geopende mail bewaren, zodat ze de tweede keer meteen
// openklapt zonder de server te bevragen.
function bewaarBody(accountKey, folder, uid, body) {
  const data = lees(accountKey, folder);
  data.bodies[uid] = { ...body, bewaardOp: Date.now() };

  // Niet oneindig laten aangroeien: enkel de recentst geopende bewaren.
  const uids = Object.keys(data.bodies);
  if (uids.length > MAX_BEWAARDE_BERICHTEN) {
    uids
      .sort((a, b) => (data.bodies[a].bewaardOp || 0) - (data.bodies[b].bewaardOp || 0))
      .slice(0, uids.length - MAX_BEWAARDE_BERICHTEN)
      .forEach((u) => delete data.bodies[u]);
  }
  schrijf(accountKey, folder, data);
}

function getBody(accountKey, folder, uid) {
  return lees(accountKey, folder).bodies[uid] || null;
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

module.exports = {
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
