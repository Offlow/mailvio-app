// tegoed.js — houdt in de gaten hoeveel je AI-tegoed opgaat.
//
// Waarom dit bestaat: Mailvio kan op de achtergrond honderden antwoorden
// klaarzetten. Dat is precies wat je wil als je een mail opent, maar elke
// oproep kost geld. Zonder rem loopt dat op zonder dat je het ziet.
//
// Hier wordt per dag geteld wat er verbruikt is, wordt de kostprijs geschat, en
// wordt er gestopt zodra de daggrens bereikt is. Wat JIJ zelf aanklikt gaat
// altijd door — de rem geldt enkel voor het werk op de achtergrond.
const fs = require("fs");
const path = require("path");

const BESTAND = path.join(__dirname, "data", "tegoed.json");

// Richtprijzen per miljoen tokens (dollar). Bewust ruim geschat: liever te
// vroeg op de rem dan een verrassing op je factuur.
const PRIJS = {
  snel: { in: 1.0, uit: 5.0 },   // het snelle model, voor beoordelen
  slim: { in: 3.0, uit: 15.0 },  // het slimme model, voor schrijven
};

// Hoeveel de ACHTERGROND per dag mag uitgeven. Wat jij zelf aanklikt telt mee
// in de teller, maar wordt nooit geweigerd.
const DAGGRENS_DOLLAR = 1.0;

let _store = null;
let _timer = null;

function vandaag() {
  return new Date().toISOString().slice(0, 10);
}

function lees() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(BESTAND, "utf8"));
  } catch (e) {
    _store = {};
  }
  return _store;
}

function planSchrijven() {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    try {
      const dir = path.dirname(BESTAND);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(BESTAND, JSON.stringify(_store || {}), "utf8");
    } catch (e) { /* niet erg */ }
  }, 2000);
  if (_timer.unref) _timer.unref();
}

function dagRegel() {
  const store = lees();
  const d = vandaag();
  if (!store[d]) store[d] = { oproepen: 0, tokensIn: 0, tokensUit: 0, dollar: 0, perSoort: {} };
  // Alles ouder dan veertien dagen mag weg.
  const grens = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const dag of Object.keys(store)) if (dag < grens) delete store[dag];
  return store[d];
}

// Eén AI-oproep bijboeken. soort = "snel" of "slim"; waarvoor = "beoordelen",
// "antwoord klaarzetten", "chat", ...
function boek(soort, waarvoor, verbruik) {
  const regel = dagRegel();
  const inTok = (verbruik && verbruik.input_tokens) || 0;
  const uitTok = (verbruik && verbruik.output_tokens) || 0;
  const prijs = PRIJS[soort] || PRIJS.slim;
  const kost = (inTok / 1e6) * prijs.in + (uitTok / 1e6) * prijs.uit;
  regel.oproepen++;
  regel.tokensIn += inTok;
  regel.tokensUit += uitTok;
  regel.dollar = Math.round((regel.dollar + kost) * 10000) / 10000;
  const vak = regel.perSoort[waarvoor] || { oproepen: 0, dollar: 0 };
  vak.oproepen++;
  vak.dollar = Math.round((vak.dollar + kost) * 10000) / 10000;
  regel.perSoort[waarvoor] = vak;
  planSchrijven();
  return regel;
}

// Mag de achtergrond nog werk doen vandaag?
function magNog() {
  return dagRegel().dollar < DAGGRENS_DOLLAR;
}

function vandaagVerbruik() {
  const regel = dagRegel();
  return {
    dollar: Math.round(regel.dollar * 100) / 100,
    oproepen: regel.oproepen,
    grens: DAGGRENS_DOLLAR,
    perSoort: regel.perSoort,
    magNog: magNog(),
  };
}

function overzicht() {
  const store = lees();
  return Object.entries(store)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14)
    .map(([dag, r]) => ({ dag, dollar: Math.round(r.dollar * 100) / 100, oproepen: r.oproepen, perSoort: r.perSoort }));
}

module.exports = { boek, magNog, vandaagVerbruik, overzicht, DAGGRENS_DOLLAR };
