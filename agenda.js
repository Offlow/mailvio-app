// agenda.js — je afspraken in Mailvio zelf.
//
// Tot nu maakte Mailvio enkel een .ics-bestand dat je in Apple Agenda of Google
// Agenda kon openen. Dat blijft, maar de afspraak wordt nu ook hier bewaard,
// zodat je in Mailvio een weekoverzicht hebt van wat er gepland staat — en zodat
// bij een klant meteen te zien is wanneer je nog bij hem langsgaat.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BESTAND = path.join(__dirname, "data", "agenda.json");

function lees() {
  try {
    return JSON.parse(fs.readFileSync(BESTAND, "utf8"));
  } catch (e) {
    return {};
  }
}

function schrijf(data) {
  const dir = path.dirname(BESTAND);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BESTAND, JSON.stringify(data, null, 2), "utf8");
}

function ruwe(accountKey) {
  return lees()[accountKey] || [];
}

function bewaarLijst(accountKey, lijst) {
  const data = lees();
  data[accountKey] = lijst;
  schrijf(data);
}

// Alle afspraken, chronologisch.
function getAlle(accountKey) {
  return ruwe(accountKey)
    .slice()
    .sort((a, b) => String(a.datum + a.begin).localeCompare(String(b.datum + b.begin)));
}

// Afspraken binnen een periode (voor de weekweergave). Datums zijn "JJJJ-MM-DD".
function getTussen(accountKey, van, tot) {
  return getAlle(accountKey).filter((a) => a.datum >= van && a.datum <= tot);
}

// De eerstvolgende afspraak met een bepaald e-mailadres — voor de klantenfiche.
function volgendeVoor(accountKey, adres) {
  const vandaag = new Date().toISOString().slice(0, 10);
  const a = String(adres || "").toLowerCase();
  if (!a) return null;
  return getAlle(accountKey).find((x) => x.datum >= vandaag && String(x.klantAdres || "").toLowerCase() === a) || null;
}

function voegToe(accountKey, afspraak) {
  if (!accountKey || !afspraak || !afspraak.datum) return null;
  const lijst = ruwe(accountKey);
  const item = {
    id: crypto.randomBytes(8).toString("hex"),
    titel: String(afspraak.titel || "Afspraak").trim(),
    datum: String(afspraak.datum),            // JJJJ-MM-DD
    begin: String(afspraak.begin || "09:00"), // UU:MM
    duur: Number(afspraak.duur) || 60,        // minuten
    plaats: String(afspraak.plaats || ""),
    notitie: String(afspraak.notitie || ""),
    klant: String(afspraak.klant || ""),
    klantAdres: String(afspraak.klantAdres || ""),
    uid: afspraak.uid !== undefined ? afspraak.uid : null,
    op: Date.now(),
  };
  lijst.push(item);
  bewaarLijst(accountKey, lijst);
  return item;
}

function wijzig(accountKey, id, velden) {
  const lijst = ruwe(accountKey);
  const item = lijst.find((x) => x.id === id);
  if (!item) return null;
  for (const veld of ["titel", "datum", "begin", "plaats", "notitie"]) {
    if (typeof velden[veld] === "string") item[veld] = velden[veld];
  }
  if (velden.duur !== undefined) item.duur = Number(velden.duur) || item.duur;
  bewaarLijst(accountKey, lijst);
  return item;
}

function verwijder(accountKey, id) {
  bewaarLijst(accountKey, ruwe(accountKey).filter((x) => x.id !== id));
}

// ---------------------------------------------------------------------------
// Abonnementssleutel voor Google Agenda
// ---------------------------------------------------------------------------
// Google Agenda kan een agenda "volgen" via een webadres. Dat adres moet Google
// zonder wachtwoord kunnen ophalen, dus beveiligen we het met een lange,
// geheime sleutel in de link zelf. Wie de link niet heeft, ziet niets.
const SLEUTELBESTAND = path.join(__dirname, "data", "agenda-sleutel.txt");

function abonnementsSleutel() {
  try {
    const bestaand = fs.readFileSync(SLEUTELBESTAND, "utf8").trim();
    if (bestaand.length >= 20) return bestaand;
  } catch (e) { /* nog geen sleutel */ }
  const nieuw = crypto.randomBytes(24).toString("hex");
  const dir = path.dirname(SLEUTELBESTAND);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SLEUTELBESTAND, nieuw, { encoding: "utf8", mode: 0o600 });
  return nieuw;
}

function nieuweSleutel() {
  try { fs.unlinkSync(SLEUTELBESTAND); } catch (e) { /* bestond niet */ }
  return abonnementsSleutel();
}

// ---------------------------------------------------------------------------
// De volledige agenda als .ics-bestand
// ---------------------------------------------------------------------------
// Dit is het formaat dat Google Agenda, Apple Agenda en Outlook begrijpen.
// Tijden worden bewust ZONDER "Z" geschreven: dat betekent lokale tijd, zodat
// 14u30 in Mailvio ook 14u30 in je agenda is en niet 16u30 wordt.
function ontsnap(tekst) {
  return String(tekst || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function plus(datum, begin, minuten) {
  const [j, m, d] = String(datum).split("-").map(Number);
  const [u, min] = String(begin || "09:00").split(":").map(Number);
  const dt = new Date(j, (m || 1) - 1, d || 1, u || 0, min || 0);
  dt.setMinutes(dt.getMinutes() + (Number(minuten) || 60));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}T${p(dt.getHours())}${p(dt.getMinutes())}00`;
}

function alsIcs(accountKey) {
  const nu = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const regels = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mailvio//Agenda//NL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Mailvio",
    "X-WR-TIMEZONE:Europe/Brussels",
    // Hoe vaak Google mag komen kijken of er iets veranderd is.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const a of getAlle(accountKey)) {
    const start = `${String(a.datum).replace(/-/g, "")}T${String(a.begin || "09:00").replace(":", "")}00`;
    regels.push(
      "BEGIN:VEVENT",
      `UID:${a.id}@mailvio`,
      `DTSTAMP:${nu}`,
      `DTSTART:${start}`,
      `DTEND:${plus(a.datum, a.begin, a.duur)}`,
      `SUMMARY:${ontsnap(a.titel)}`
    );
    if (a.plaats) regels.push(`LOCATION:${ontsnap(a.plaats)}`);
    const omschrijving = [a.notitie, a.klant ? `Klant: ${a.klant}` : "", a.klantAdres].filter(Boolean).join("\n");
    if (omschrijving) regels.push(`DESCRIPTION:${ontsnap(omschrijving)}`);
    regels.push("END:VEVENT");
  }
  regels.push("END:VCALENDAR");
  // Volgens de norm eindigt elke regel op CRLF.
  return regels.join("\r\n") + "\r\n";
}

module.exports = { getAlle, getTussen, volgendeVoor, voegToe, wijzig, verwijder, abonnementsSleutel, nieuweSleutel, alsIcs };
