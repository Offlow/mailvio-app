// afzenders.js — onthoudt per afzender wat JIJ beslist hebt.
//
// Als Mailvio twijfelt of een mail reclame is, vraagt ze het op het dashboard.
// Jouw antwoord wordt hier bewaard per e-mailadres, zodat dezelfde afzender
// nooit twee keer dezelfde vraag oplevert: de volgende mail van dat adres gaat
// meteen naar de juiste plek.
//
// Jouw beslissing weegt altijd zwaarder dan het oordeel van de AI.
const fs = require("fs");
const path = require("path");

const BESTAND = path.join(__dirname, "data", "afzenders.json");

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

function normaliseerAdres(adres) {
  return String(adres || "").trim().toLowerCase();
}

function getAlle(accountKey) {
  return lees()[accountKey] || {};
}

// Wat weten we over deze afzender? Geeft null terug als je er nog nooit iets
// over beslist hebt.
function oordeel(accountKey, adres) {
  const a = normaliseerAdres(adres);
  if (!a) return null;
  const perAccount = getAlle(accountKey);
  if (perAccount[a]) return perAccount[a];

  // Niets over dit exacte adres? Kijk dan of je al iets besliste over het
  // domein (bv. alle mail van @nieuwsbrief-xyz.com is reclame). Handig bij
  // afzenders die telkens met een ander adres mailen.
  const domein = a.split("@")[1];
  if (domein && perAccount["@" + domein]) return perAccount["@" + domein];
  return null;
}

// Jouw beslissing bewaren. reclame = true betekent: alles van dit adres is
// reclame. heelDomein = true bewaart het voor het hele domein.
function beslis(accountKey, adres, reclame, heelDomein) {
  const a = normaliseerAdres(adres);
  if (!accountKey || !a) return null;
  const data = lees();
  const perAccount = data[accountKey] || {};
  const sleutel = heelDomein ? "@" + a.split("@")[1] : a;
  perAccount[sleutel] = { reclame: !!reclame, bron: "gebruiker", op: Date.now() };
  data[accountKey] = perAccount;
  schrijf(data);
  return perAccount[sleutel];
}

function vergeet(accountKey, adres) {
  const a = normaliseerAdres(adres);
  const data = lees();
  const perAccount = data[accountKey] || {};
  delete perAccount[a];
  delete perAccount["@" + a.split("@")[1]];
  data[accountKey] = perAccount;
  schrijf(data);
}

// Alles wat je ooit als reclame of als echte mail aanduidde — voor het
// overzicht in de instellingen, zodat je een vergissing kan terugdraaien.
function overzicht(accountKey) {
  const perAccount = getAlle(accountKey);
  return Object.entries(perAccount)
    .map(([adres, v]) => ({ adres, ...v }))
    .sort((a, b) => (b.op || 0) - (a.op || 0));
}

module.exports = { oordeel, beslis, vergeet, overzicht, getAlle };
