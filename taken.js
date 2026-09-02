// taken.js — je eigen to-dolijst in Mailvio.
//
// Twee soorten taken komen hier samen:
//  1. Taken die je zelf typt ("nog een offerte maken voor Peeters").
//  2. Mails die je in de to-domap sleept — die worden een taak, of hangen zich
//     aan een taak die er al staat.
//
// Elke taak kan subtaken hebben en kan afgevinkt worden. Alles blijft op schijf
// staan (in de data-map, op het Fly-volume), dus een herstart raakt niets kwijt.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BESTAND = path.join(__dirname, "data", "taken.json");

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

function nieuwId() {
  return crypto.randomBytes(8).toString("hex");
}

function getAlle(accountKey) {
  const lijst = lees()[accountKey] || [];
  // Openstaande taken eerst, daarbinnen de nieuwste bovenaan. Afgevinkte taken
  // zakken naar onder maar verdwijnen niet: je kan een vergissing terugdraaien.
  return lijst.slice().sort((a, b) => {
    if (!!a.klaar !== !!b.klaar) return a.klaar ? 1 : -1;
    return (b.op || 0) - (a.op || 0);
  });
}

function bewaarLijst(accountKey, lijst) {
  const data = lees();
  data[accountKey] = lijst;
  schrijf(data);
}

function ruwe(accountKey) {
  return lees()[accountKey] || [];
}

function vind(lijst, id) {
  return lijst.find((t) => t.id === id) || null;
}

// --- taken ------------------------------------------------------------------

function voegToe(accountKey, titel, extra) {
  const schoon = String(titel || "").trim();
  if (!accountKey || !schoon) return null;
  const lijst = ruwe(accountKey);
  const taak = {
    id: nieuwId(),
    titel: schoon,
    klaar: false,
    op: Date.now(),
    klaarOp: null,
    notitie: (extra && extra.notitie) || "",
    mails: (extra && extra.mails) || [],
    subtaken: [],
  };
  lijst.push(taak);
  bewaarLijst(accountKey, lijst);
  return taak;
}

function wijzig(accountKey, id, velden) {
  const lijst = ruwe(accountKey);
  const taak = vind(lijst, id);
  if (!taak) return null;
  if (typeof velden.titel === "string" && velden.titel.trim()) taak.titel = velden.titel.trim();
  if (typeof velden.notitie === "string") taak.notitie = velden.notitie;
  if (typeof velden.klaar === "boolean") {
    taak.klaar = velden.klaar;
    taak.klaarOp = velden.klaar ? Date.now() : null;
    // Een taak afvinken vinkt ook alles eronder af — anders blijft er een
    // halve taak openstaan die niets meer betekent.
    if (velden.klaar) for (const s of taak.subtaken || []) s.klaar = true;
  }
  bewaarLijst(accountKey, lijst);
  return taak;
}

function verwijder(accountKey, id) {
  const lijst = ruwe(accountKey).filter((t) => t.id !== id);
  bewaarLijst(accountKey, lijst);
}

// --- subtaken ---------------------------------------------------------------

function voegSubtaakToe(accountKey, id, titel) {
  const schoon = String(titel || "").trim();
  if (!schoon) return null;
  const lijst = ruwe(accountKey);
  const taak = vind(lijst, id);
  if (!taak) return null;
  taak.subtaken = taak.subtaken || [];
  const sub = { id: nieuwId(), titel: schoon, klaar: false };
  taak.subtaken.push(sub);
  // Een nieuwe subtaak betekent dat er weer werk is: de taak gaat terug open.
  if (taak.klaar) {
    taak.klaar = false;
    taak.klaarOp = null;
  }
  bewaarLijst(accountKey, lijst);
  return taak;
}

function wijzigSubtaak(accountKey, id, subId, velden) {
  const lijst = ruwe(accountKey);
  const taak = vind(lijst, id);
  if (!taak) return null;
  const sub = (taak.subtaken || []).find((s) => s.id === subId);
  if (!sub) return null;
  if (typeof velden.titel === "string" && velden.titel.trim()) sub.titel = velden.titel.trim();
  if (typeof velden.klaar === "boolean") sub.klaar = velden.klaar;
  // Zijn alle subtaken afgevinkt, dan is de taak zelf ook rond.
  const subs = taak.subtaken || [];
  if (subs.length && subs.every((s) => s.klaar) && !taak.klaar) {
    taak.klaar = true;
    taak.klaarOp = Date.now();
  } else if (!sub.klaar && taak.klaar) {
    taak.klaar = false;
    taak.klaarOp = null;
  }
  bewaarLijst(accountKey, lijst);
  return taak;
}

function verwijderSubtaak(accountKey, id, subId) {
  const lijst = ruwe(accountKey);
  const taak = vind(lijst, id);
  if (!taak) return null;
  taak.subtaken = (taak.subtaken || []).filter((s) => s.id !== subId);
  bewaarLijst(accountKey, lijst);
  return taak;
}

// --- mails aan een taak hangen ---------------------------------------------

function koppelMail(accountKey, id, mail) {
  const lijst = ruwe(accountKey);
  const taak = vind(lijst, id);
  if (!taak || !mail || mail.uid === undefined) return null;
  taak.mails = taak.mails || [];
  const folder = mail.folder || "INBOX";
  if (!taak.mails.some((m) => String(m.uid) === String(mail.uid) && (m.folder || "INBOX") === folder)) {
    taak.mails.push({
      uid: mail.uid,
      folder,
      subject: mail.subject || "(geen onderwerp)",
      from: mail.from || "",
      fromAddress: mail.fromAddress || "",
      date: mail.date || null,
    });
  }
  bewaarLijst(accountKey, lijst);
  return taak;
}

function ontkoppelMail(accountKey, id, uid, folder) {
  const lijst = ruwe(accountKey);
  const taak = vind(lijst, id);
  if (!taak) return null;
  const f = folder || "INBOX";
  taak.mails = (taak.mails || []).filter((m) => !(String(m.uid) === String(uid) && (m.folder || "INBOX") === f));
  bewaarLijst(accountKey, lijst);
  return taak;
}

// Hoeveel taken staan er nog open? (voor het cijfer naast de map)
function aantalOpen(accountKey) {
  return ruwe(accountKey).filter((t) => !t.klaar).length;
}

module.exports = {
  getAlle,
  voegToe,
  wijzig,
  verwijder,
  voegSubtaakToe,
  wijzigSubtaak,
  verwijderSubtaak,
  koppelMail,
  ontkoppelMail,
  aantalOpen,
};
