// bijlagen.js — bewaart de samenvatting van een bijlage op schijf.
//
// Een bijlage lezen kost tijd en een AI-oproep. Daarom doen we dat maar één
// keer: de twee zinnen die eruit komen blijven bewaard in de data-map, zodat
// dezelfde mail later meteen zijn samenvatting toont — ook na een herstart.
const fs = require("fs");
const path = require("path");

const BESTAND = path.join(__dirname, "data", "bijlagesamenvattingen.json");

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
  fs.writeFileSync(BESTAND, JSON.stringify(data), "utf8");
}

function sleutel(folder, uid, index) {
  return `${folder || "INBOX"}|${uid}|${index}`;
}

function get(accountKey, folder, uid, index) {
  const data = lees();
  const perAccount = data[accountKey] || {};
  return perAccount[sleutel(folder, uid, index)] || null;
}

function bewaar(accountKey, folder, uid, index, waarde) {
  if (!accountKey) return;
  const data = lees();
  const perAccount = data[accountKey] || {};
  perAccount[sleutel(folder, uid, index)] = { ...waarde, op: Date.now() };
  data[accountKey] = perAccount;
  schrijf(data);
}

module.exports = { get, bewaar };
