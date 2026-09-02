// regels.js — automatisering met een schakelaar.
//
// Alles wat Mailvio automatisch doet, staat hier als een regel die je kan
// uitzetten. Twee soorten:
//
//  1. INGEBOUWDE regels — de slimmigheden die er al in zaten (reclame
//     herkennen, aanvragen via daklo.be voorrang geven, bijlagen samenvatten,
//     ...). Die staan standaard aan, maar als er ooit iets fout mee loopt, zet
//     je ze met één klik uit zonder dat de rest stilvalt.
//
//  2. EIGEN regels — die je zelf maakt: "als de afzender X is, doe Y".
//
// Zo staat op één plek wat de app allemaal uit zichzelf doet, en beslis jij.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BESTAND = path.join(__dirname, "data", "regels.json");

// De ingebouwde automatiseringen. De sleutel wordt in de code opgevraagd met
// aanstaat(accountKey, "sleutel").
const INGEBOUWD = [
  {
    sleutel: "reclame_herkennen",
    naam: "Reclame herkennen",
    uitleg: "Mailvio beoordeelt zelf of een mail reclame of een nieuwsbrief is en houdt die apart van je gewone post.",
  },
  {
    sleutel: "reclame_vragen",
    naam: "Vragen bij twijfel",
    uitleg: "Twijfelt Mailvio of iets reclame is, dan vraagt ze het op je dashboard met een ✓ en een ✗.",
  },
  {
    sleutel: "afzender_onthouden",
    naam: "Je oordeel onthouden",
    uitleg: "Wat je één keer over een afzender beslist, geldt voortaan voor élke mail van dat adres.",
  },
  {
    sleutel: "website_voorrang",
    naam: "Aanvragen via daklo.be voorrang geven",
    uitleg: "Een offerteaanvraag of contactformulier via je website wordt altijd als dringend en belangrijk gemarkeerd.",
  },
  {
    sleutel: "bijlage_samenvatten",
    naam: "Bijlagen samenvatten",
    uitleg: "Onder elke bijlage komen twee zinnen: wat het is en wat er in staat. Kost een AI-oproep per bijlage.",
  },
  {
    sleutel: "afspraak_herkennen",
    naam: "Afspraken uit mails halen",
    uitleg: "Staat er een datum of plaatsbezoek in een mail, dan haalt Mailvio die eruit voor de agendaknop.",
  },
  {
    sleutel: "antwoord_afhandelen",
    naam: "Afhandelen na een antwoord",
    uitleg: "Beantwoord je een mail via Mailvio, dan verdwijnt die zaak vanzelf uit je openstaande lijst.",
  },
];

// Kleine cache. Zonder deze werd dit bestand voor ELKE mail opnieuw van schijf
// gelezen — bij 1500 mails duizenden keren per aanvraag, en dan staat de hele
// app stil. De cache vervalt na een seconde en wordt gewist bij elk schrijven,
// dus je ziet een wijziging altijd meteen.
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

function voorAccount(accountKey) {
  const data = lees();
  const eigen = data[accountKey] || {};
  return { ingebouwd: eigen.ingebouwd || {}, eigen: eigen.eigen || [] };
}

function bewaar(accountKey, waarde) {
  const data = lees();
  data[accountKey] = waarde;
  schrijf(data);
}

// Staat een ingebouwde regel aan? Standaard JA — je moet iets bewust uitzetten.
function aanstaat(accountKey, sleutel) {
  const { ingebouwd } = voorAccount(accountKey);
  return ingebouwd[sleutel] !== false;
}

function zetIngebouwd(accountKey, sleutel, aan) {
  if (!INGEBOUWD.some((r) => r.sleutel === sleutel)) return null;
  const huidig = voorAccount(accountKey);
  huidig.ingebouwd[sleutel] = !!aan;
  bewaar(accountKey, huidig);
  return overzicht(accountKey);
}

// --- eigen regels -----------------------------------------------------------

// Een regel is: ALS <veld> <test> <waarde> DAN <acties>.
const VELDEN = ["afzender", "onderwerp", "inhoud", "soort"];
const TESTEN = ["bevat", "is", "begint_met"];
const ACTIES = ["reclame", "belangrijk", "dringend", "geen_actie", "taak", "niet_opvolgen"];

function voegToe(accountKey, regel) {
  const naam = String(regel?.naam || "").trim();
  const veld = VELDEN.includes(regel?.veld) ? regel.veld : "afzender";
  const test = TESTEN.includes(regel?.test) ? regel.test : "bevat";
  const waarde = String(regel?.waarde || "").trim();
  const acties = (regel?.acties || []).filter((a) => ACTIES.includes(a));
  if (!waarde || !acties.length) return null;

  const huidig = voorAccount(accountKey);
  const nieuw = {
    id: crypto.randomBytes(8).toString("hex"),
    naam: naam || `Als ${veld} ${test.replace("_", " ")} "${waarde}"`,
    veld,
    test,
    waarde,
    acties,
    aan: true,
    op: Date.now(),
  };
  huidig.eigen.push(nieuw);
  bewaar(accountKey, huidig);
  return nieuw;
}

function wijzigEigen(accountKey, id, velden) {
  const huidig = voorAccount(accountKey);
  const regel = huidig.eigen.find((r) => r.id === id);
  if (!regel) return null;
  if (typeof velden.aan === "boolean") regel.aan = velden.aan;
  if (typeof velden.naam === "string" && velden.naam.trim()) regel.naam = velden.naam.trim();
  if (typeof velden.waarde === "string" && velden.waarde.trim()) regel.waarde = velden.waarde.trim();
  bewaar(accountKey, huidig);
  return regel;
}

function verwijderEigen(accountKey, id) {
  const huidig = voorAccount(accountKey);
  huidig.eigen = huidig.eigen.filter((r) => r.id !== id);
  bewaar(accountKey, huidig);
}

function overzicht(accountKey) {
  const { ingebouwd, eigen } = voorAccount(accountKey);
  return {
    ingebouwd: INGEBOUWD.map((r) => ({ ...r, aan: ingebouwd[r.sleutel] !== false })),
    eigen,
  };
}

// Past je eigen regels toe op de beoordeling van één mail. De eerste regel die
// past wint niet: ALLE passende regels worden toegepast, in de volgorde waarin
// je ze gemaakt hebt. Zo kan je bv. iets tegelijk belangrijk én een taak maken.
function pasToe(accountKey, mail, beoordeling) {
  const { eigen } = voorAccount(accountKey);
  const geraakt = [];
  for (const regel of eigen) {
    if (!regel.aan) continue;
    const bron = {
      afzender: `${mail.from || ""} ${mail.fromAddress || ""}`,
      onderwerp: mail.subject || "",
      inhoud: mail.snippet || "",
      soort: beoordeling.soort || "",
    }[regel.veld] || "";

    const a = String(bron).toLowerCase();
    const b = String(regel.waarde).toLowerCase();
    const past = regel.test === "is" ? a.trim() === b : regel.test === "begint_met" ? a.trim().startsWith(b) : a.includes(b);
    if (!past) continue;

    geraakt.push(regel);
    for (const actie of regel.acties) {
      if (actie === "reclame") {
        beoordeling.soort = "reclame";
        beoordeling.categorie = "geen_actie";
        beoordeling.belangrijk = false;
        beoordeling.actieLabel = "";
        beoordeling.reclameTwijfel = false;
      } else if (actie === "belangrijk") {
        beoordeling.belangrijk = true;
      } else if (actie === "dringend") {
        beoordeling.categorie = "dringend";
        if (!beoordeling.actieLabel) beoordeling.actieLabel = "Beantwoorden";
      } else if (actie === "geen_actie") {
        beoordeling.categorie = "geen_actie";
        beoordeling.actieLabel = "";
      } else if (actie === "niet_opvolgen") {
        beoordeling.genegeerd = true;
        beoordeling.resolved = true;
      }
      // "taak" wordt in server.js afgehandeld, want daar zit de takenlijst.
    }
  }
  return geraakt;
}

module.exports = {
  INGEBOUWD,
  aanstaat,
  zetIngebouwd,
  voegToe,
  wijzigEigen,
  verwijderEigen,
  overzicht,
  pasToe,
};
