// classifications.js — houdt de AI-beoordeling (categorie/reden/vanType/actieLabel)
// en het opgehaalde fragment per mail (uid) PERMANENT bij op schijf, per mailaccount.
// Zo moet een mail maar één keer gescand worden — ook na een herstart of herdeploy
// (zolang de "data"-map bewaard blijft, bv. via een Fly.io Volume).
const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "data", "classifications.json");

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function writeStore(store) {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store), "utf8");
}

// Alles wordt genest onder de accountsleutel (het IMAP-mailadres) zodat een
// latere koppeling met een ANDER mailaccount nooit per ongeluk de labels van
// een vorig account overneemt (mail-uid's zijn enkel uniek binnen één mailbox).
function getAll(accountKey) {
  const store = readStore();
  return store[accountKey] || {};
}

function setMany(accountKey, entries) {
  if (!accountKey || !entries.length) return;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  for (const e of entries) {
    // Behoud een eventueel al gezette "afgehandeld"-status (setResolved kan al
    // gebeurd zijn vóór de AI-classificatie klaar was) — nooit overschrijven.
    const existing = forAccount[e.uid] || {};
    forAccount[e.uid] = {
      ...existing,
      categorie: e.categorie,
      reden: e.reden || "",
      vanType: e.vanType || "onbekend",
      actieLabel: e.actieLabel || "",
      soort: e.soort || "overig",
      belangrijk: !!e.belangrijk,
      snippet: e.snippet || "",
      classifiedAt: Date.now(),
    };
  }
  store[accountKey] = forAccount;
  writeStore(store);
}

// Markeert een mail expliciet als afgehandeld/niet-afgehandeld. Dit gebeurt
// ENKEL op vraag van de gebruiker (knop "Afgehandeld") of automatisch nadat
// er via Mailvio effectief op geantwoord is — nooit door een herscan, een
// cache-ververs of het verstrijken van tijd. Zo verdwijnt een openstaande
// zaak nooit uit zichzelf.
function setResolved(accountKey, uid, resolved) {
  if (!accountKey) return null;
  const store = readStore();
  const forAccount = store[accountKey] || {};
  const existing = forAccount[uid] || {};
  const entry = { ...existing, resolved: !!resolved, resolvedAt: resolved ? Date.now() : null };
  forAccount[uid] = entry;
  store[accountKey] = forAccount;
  writeStore(store);
  return entry;
}

module.exports = { getAll, setMany, setResolved };
