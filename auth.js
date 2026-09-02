// auth.js — beschermt Mailvio met een inlog.
//
// Zonder dit kan iedereen die het webadres kent je volledige mailbox lezen en
// zelfs mails versturen in jouw naam. Daarom: één wachtwoord dat jij zelf kiest,
// en een sessie die daarna een tijd blijft gelden zodat je niet elke keer
// opnieuw moet inloggen.
//
// Het wachtwoord zelf wordt NOOIT bewaard — enkel een onomkeerbare afdruk
// (hash) ervan, met een eigen 'salt'. Zelfs wie het instellingenbestand in
// handen krijgt, kan het wachtwoord daar niet uit afleiden.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const AUTH_FILE = path.join(__dirname, "data", "auth.json");
const SESSIE_DAGEN = 30;
const COOKIE_NAAM = "mailvio_sessie";

// Trager algoritme dan een gewone hash: maakt gokken duur voor een aanvaller.
const ITERATIES = 210000;

function lees() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function schrijf(data) {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch (e) { /* niet kritiek */ }
}

function maakHash(wachtwoord, salt) {
  return crypto.pbkdf2Sync(String(wachtwoord), salt, ITERATIES, 64, "sha512").toString("hex");
}

// Is er al een wachtwoord ingesteld?
function isIngesteld() {
  const d = lees();
  return !!(d.hash && d.salt);
}

function stelWachtwoordIn(wachtwoord) {
  const w = String(wachtwoord || "");
  if (w.length < 8) throw new Error("Kies een wachtwoord van minstens 8 tekens.");
  const salt = crypto.randomBytes(16).toString("hex");
  const data = lees();
  data.salt = salt;
  data.hash = maakHash(w, salt);
  data.gewijzigd = Date.now();
  // Alle bestaande sessies vervallen bij een nieuw wachtwoord.
  data.sessies = [];
  schrijf(data);
}

function wijzigWachtwoord(oud, nieuw) {
  if (isIngesteld() && !klopt(oud)) throw new Error("Het huidige wachtwoord klopt niet.");
  stelWachtwoordIn(nieuw);
}

// Vergelijking die even lang duurt bij een juiste als bij een foute poging,
// zodat er niets af te leiden valt uit de responstijd.
function klopt(wachtwoord) {
  const d = lees();
  if (!d.hash || !d.salt) return false;
  const poging = Buffer.from(maakHash(wachtwoord || "", d.salt), "hex");
  const echt = Buffer.from(d.hash, "hex");
  if (poging.length !== echt.length) return false;
  return crypto.timingSafeEqual(poging, echt);
}

function nieuweSessie() {
  const d = lees();
  const token = crypto.randomBytes(32).toString("hex");
  const verlooptOp = Date.now() + SESSIE_DAGEN * 24 * 60 * 60 * 1000;
  d.sessies = (d.sessies || []).filter((s) => s.verlooptOp > Date.now());
  d.sessies.push({ token, verlooptOp, gemaaktOp: Date.now() });
  schrijf(d);
  return { token, verlooptOp };
}

function sessieGeldig(token) {
  if (!token) return false;
  const d = lees();
  const s = (d.sessies || []).find((x) => x.token === token);
  return !!(s && s.verlooptOp > Date.now());
}

function beeindigSessie(token) {
  const d = lees();
  d.sessies = (d.sessies || []).filter((s) => s.token !== token);
  schrijf(d);
}

function beeindigAlleSessies() {
  const d = lees();
  d.sessies = [];
  schrijf(d);
}

// Haalt het sessie-token uit de cookies van de aanvraag.
function tokenUitVerzoek(req) {
  const cookie = req.headers?.cookie || "";
  const stuk = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE_NAAM + "="));
  return stuk ? decodeURIComponent(stuk.slice(COOKIE_NAAM.length + 1)) : null;
}

function zetCookie(res, token, verlooptOp) {
  const maxAge = Math.max(0, Math.floor((verlooptOp - Date.now()) / 1000));
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAAM}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`
  );
}

function wisCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAAM}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
}

module.exports = {
  isIngesteld,
  stelWachtwoordIn,
  wijzigWachtwoord,
  klopt,
  nieuweSessie,
  sessieGeldig,
  beeindigSessie,
  beeindigAlleSessies,
  tokenUitVerzoek,
  zetCookie,
  wisCookie,
  COOKIE_NAAM,
};
