// klanten.js — wat je zelf over een klant bijhoudt, plus wat Mailvio uit de
// mails haalde.
//
// Twee dingen worden hier bewaard, per e-mailadres:
//  1. Jouw eigen notities ("belt liefst na 17u", "achterkant huis, poort links").
//  2. De gegevens die uit de mailgeschiedenis komen — telefoonnummers, adressen,
//     contactpersonen. Die worden bewaard zodat de fiche meteen gevuld is en de
//     AI niet bij elk bezoek opnieuw alles moet doorlezen.
const fs = require("fs");
const path = require("path");

const BESTAND = path.join(__dirname, "data", "klanten.json");

let _cache = null;
let _cacheOp = 0;
const CACHE_MS = 1000;

function lees() {
  if (_cache && Date.now() - _cacheOp < CACHE_MS) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(BESTAND, "utf8"));
  } catch (e) {
    _cache = {};
  }
  _cacheOp = Date.now();
  return _cache;
}

function schrijf(data) {
  const dir = path.dirname(BESTAND);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _cache = data;
  _cacheOp = Date.now();
  fs.writeFileSync(BESTAND, JSON.stringify(data, null, 2), "utf8");
}

function sleutel(adres) {
  return String(adres || "").trim().toLowerCase();
}

function get(accountKey, adres) {
  const data = lees();
  return (data[accountKey] || {})[sleutel(adres)] || null;
}

function bewaarVeld(accountKey, adres, velden) {
  const a = sleutel(adres);
  if (!accountKey || !a) return null;
  const data = lees();
  const perAccount = data[accountKey] || {};
  perAccount[a] = { ...(perAccount[a] || {}), ...velden, bijgewerkt: Date.now() };
  data[accountKey] = perAccount;
  schrijf(data);
  return perAccount[a];
}

function zetNotitie(accountKey, adres, notitie) {
  return bewaarVeld(accountKey, adres, { notitie: String(notitie || "") });
}

function zetGegevens(accountKey, adres, gegevens) {
  return bewaarVeld(accountKey, adres, { gegevens, gegevensOp: Date.now() });
}

// ---------------------------------------------------------------------------
// Gegevens uit de tekst van mails halen
// ---------------------------------------------------------------------------
// Dit gebeurt met vaste patronen, dus zonder AI-oproep en zonder gokwerk: wat
// hier uitkomt, staat letterlijk in een mail. De AI vult dit later aan met wat
// meer interpretatie vraagt (bv. wie de contactpersoon is).

// Belgische en Nederlandse nummers, met of zonder landcode, punten, streepjes
// of spaties ertussen. Bewust streng genoeg om jaartallen en factuurnummers
// niet als telefoonnummer op te pikken.
const TELEFOON = /(?<![\d\w])(?:(?:\+|00)[\s.]?3[123][\s.]?|0)[1-9](?:[\s./-]?\d){7,8}(?![\d])/g;

function normaliseerTelefoon(ruw) {
  const cijfers = String(ruw).replace(/[^\d+]/g, "");
  // Te kort of te lang is geen telefoonnummer maar iets anders.
  const kaal = cijfers.replace(/^\+/, "");
  if (kaal.length < 9 || kaal.length > 13) return null;
  return cijfers;
}

// Straat + huisnummer, gevolgd door postcode en gemeente. Vangt de gewone
// Vlaamse schrijfwijze op ("Polderstraat 4, 9190 Stekene").
const ADRES = /([A-ZÀ-Ý][^\S\n]?[\wÀ-ÿ'’.-]*(?:[^\S\n]+[A-ZÀ-Ýa-zà-ÿ][\wÀ-ÿ'’.-]*){0,3}[^\S\n]+\d+[^\S\n]?[a-zA-Z]?)[^\S\n]*[,\n][^\S\n]*(\d{4})[^\S\n]+([A-ZÀ-Ý][\wÀ-ÿ'’-]+(?:[^\S\n-]?-?[^\S\n]?[A-ZÀ-Ý][\wÀ-ÿ'’-]+)?)/g;

function haalUitTekst(teksten) {
  const telefoons = new Map();
  const adressen = new Map();
  const websites = new Map();

  for (const tekst of teksten) {
    const t = String(tekst || "");
    if (!t) continue;

    for (const m of t.match(TELEFOON) || []) {
      const net = normaliseerTelefoon(m);
      if (!net) continue;
      // De mooiste schrijfwijze bewaren die we tegenkwamen.
      if (!telefoons.has(net)) telefoons.set(net, m.trim());
    }

    let a;
    ADRES.lastIndex = 0;
    while ((a = ADRES.exec(t)) !== null) {
      const volledig = `${a[1].trim()}, ${a[2]} ${a[3].trim()}`;
      adressen.set(volledig.toLowerCase(), volledig);
    }

    for (const w of t.match(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/gi) || []) {
      websites.set(w.toLowerCase(), w);
    }
  }

  return {
    telefoons: [...telefoons.values()].slice(0, 5),
    adressen: [...adressen.values()].slice(0, 4),
    websites: [...websites.values()].slice(0, 3),
  };
}

module.exports = { get, zetNotitie, zetGegevens, haalUitTekst };
