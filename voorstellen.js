// voorstellen.js — bewaart het voorgestelde antwoord van de AI op schijf.
//
// Waarom: een antwoord laten opstellen kost tijd en een AI-oproep. Tot nu stond
// dat enkel in het geheugen, en werd het bij elke verversing weggegooid — dus
// zat je élke keer opnieuw een minuut te wachten als je een mail opende.
//
// Nu blijft het bewaard, en wordt het bovendien al VOORAF gemaakt voor je
// recentste mails, zodat het er gewoon staat op het moment dat je de mail
// opent.
const fs = require("fs");
const path = require("path");

const BESTAND = path.join(__dirname, "data", "voorstellen.json");

let _store = null;
let _timer = null;

function lees() {
  if (_store) return _store;
  try {
    _store = JSON.parse(fs.readFileSync(BESTAND, "utf8"));
  } catch (e) {
    _store = {};
  }
  return _store;
}

function naarSchijf() {
  try {
    const dir = path.dirname(BESTAND);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BESTAND + ".tmp", JSON.stringify(_store || {}), "utf8");
    fs.renameSync(BESTAND + ".tmp", BESTAND);
  } catch (e) {
    console.error("Kon de voorstellen niet wegschrijven:", e.message);
  }
}

function planSchrijven() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; naarSchijf(); }, 1000);
  if (_timer.unref) _timer.unref();
}

function get(accountKey, uid) {
  const store = lees();
  return (store[accountKey] || {})[uid] || null;
}

function heeft(accountKey, uid) {
  return !!get(accountKey, uid);
}

function bewaar(accountKey, uid, voorstel) {
  if (!accountKey || uid === undefined || !voorstel) return;
  const store = lees();
  const perAccount = store[accountKey] || {};
  perAccount[uid] = { ...voorstel, op: Date.now() };
  store[accountKey] = perAccount;
  planSchrijven();
}

function verwijder(accountKey, uid) {
  const store = lees();
  const perAccount = store[accountKey];
  if (!perAccount) return;
  delete perAccount[uid];
  planSchrijven();
}

function aantal(accountKey) {
  return Object.keys(lees()[accountKey] || {}).length;
}

function flush() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_store) naarSchijf();
}
for (const sein of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sein, () => { flush(); if (sein !== "exit") process.exit(0); });
}

module.exports = { get, heeft, bewaar, verwijder, aantal, flush };
