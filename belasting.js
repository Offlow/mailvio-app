// belasting.js — meet of de server nog kan ademen.
//
// Waarom dit bestaat: als Mailvio traag aanvoelt, is de vraag altijd "waaraan
// ligt het?". Van buitenaf zie je enkel dat een aanvraag lang duurt. Dit
// bestand meet aan de binnenkant hoe lang de server stilstond en WAT hij toen
// aan het doen was, en houdt de ergste momenten bij. Zo hoeven we niet meer te
// gokken.
//
// Hoe het werkt: elke 100 ms kijken we op de klok. Zijn er meer dan 100 ms
// voorbij, dan stond de server ondertussen stil — hij was toen met iets anders
// bezig en kon jouw klik niet behandelen. Dat verschil noemen we de vertraging.

let vorigeTik = Date.now();
let vertraging = 0;          // hoeveel de server op dit moment achterloopt (ms)
let bezigMet = "niets";      // waar de achtergrond nu mee bezig is
const ergste = [];           // de zwaarste blokkades, met wat er toen liep
const MAX_ERGSTE = 25;

const tik = setInterval(() => {
  const nu = Date.now();
  const achterstand = nu - vorigeTik - 100;
  vorigeTik = nu;
  // Kleine schommelingen horen erbij; enkel echte blokkades onthouden we.
  vertraging = Math.max(0, achterstand);
  if (achterstand > 250) {
    ergste.push({ ms: achterstand, bezigMet, op: new Date(nu).toISOString() });
    ergste.sort((a, b) => b.ms - a.ms);
    if (ergste.length > MAX_ERGSTE) ergste.length = MAX_ERGSTE;
  }
}, 100);
if (tik.unref) tik.unref();

// Zeg waar de achtergrond mee bezig is, zodat een blokkade een naam krijgt.
function zetBezig(wat) {
  bezigMet = wat || "niets";
}

// Loopt de server achter? Dan is dit geen moment om er nog werk bij te nemen.
function drukbezet() {
  return vertraging > 400;
}

// Wachten tot de server weer bijbeen is. Gebruikt door het inladen op de
// achtergrond: dat heeft geen haast, jouw scherm wel.
async function wachtOpRust(maxMs = 20000) {
  const tot = Date.now() + maxMs;
  while (drukbezet() && Date.now() < tot) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

function overzicht() {
  return {
    vertragingNu: vertraging,
    bezigMet,
    geheugenMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    geheugenTotaalMb: Math.round(process.memoryUsage().rss / 1048576),
    draaitAlSeconden: Math.round(process.uptime()),
    ergsteBlokkades: ergste,
  };
}

// Dezelfde meting, maar zonder één woord over je mail. Mapnamen en aantallen
// gaan eruit; wat overblijft is het SOORT werk. Zo kan dit overzicht bekeken
// worden zonder aanmelden, om te zien waaraan een trage server ligt, zonder dat
// er ook maar iets over je mailbox naar buiten komt.
function soortVan(tekst) {
  const t = String(tekst || "");
  if (/nieuwe mails ophalen/i.test(t)) return "nieuwe mails ophalen";
  if (/oudere mails ophalen/i.test(t)) return "oudere mails ophalen";
  if (/gelezen\/ongelezen/i.test(t)) return "gelezen-status nakijken";
  if (/beoordelen door de AI/i.test(t)) return "mails laten beoordelen";
  if (/fragmenten ophalen/i.test(t)) return "fragmenten ophalen";
  if (/inhoud inladen/i.test(t)) return "mailinhoud inladen";
  if (/niets/i.test(t)) return "niets";
  return "ander werk";
}

function anoniemOverzicht() {
  const o = overzicht();
  return {
    vertragingNu: o.vertragingNu,
    bezigMet: soortVan(o.bezigMet),
    geheugenMb: o.geheugenMb,
    geheugenTotaalMb: o.geheugenTotaalMb,
    draaitAlSeconden: o.draaitAlSeconden,
    ergsteBlokkades: o.ergsteBlokkades.map((b) => ({ ms: b.ms, bezigMet: soortVan(b.bezigMet), op: b.op })),
  };
}

module.exports = { zetBezig, drukbezet, wachtOpRust, overzicht, anoniemOverzicht };
