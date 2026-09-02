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

module.exports = { getAlle, getTussen, volgendeVoor, voegToe, wijzig, verwijder };
