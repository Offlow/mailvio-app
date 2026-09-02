// mailstore.js — bewaart je mails lokaal op de persistente schijf, zodat
// Mailvio niet elke keer je hele mailbox opnieuw van de server moet halen.
//
// Werkt zoals Outlook of Apple Mail: wat één keer opgehaald is, blijft staan.
// Bij het openen toont Mailvio meteen wat het al heeft, en haalt daarna enkel
// de NIEUWE berichten op. Oude mails zijn dus ook direct beschikbaar.
//
// Per mailbox (account) en per map wordt bijgehouden:
//   uidValidity  — verandert de mailserver dit, dan kloppen de oude nummers
//                  niet meer en beginnen we opnieuw (zeldzaam, maar het
//                  gebeurt bv. bij een migratie bij je provider).
//   mails        — de kopregels per uid (van, onderwerp, datum, gelezen, ...)
//   bodies       — de inhoud van mails die je al geopend hebt
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const CACHE_DIR = path.join(DATA_DIR, "mailcache");

// Hoeveel geopende mails we bewaren per mailbox. Een mail met bijlagen kan
// groot zijn; dit houdt de schijf binnen de perken.
// Nu elke mail in een eigen bestand staat, kunnen we er veel meer bewaren
// zonder dat het de app vertraagt.
const MAX_BEWAARDE_BERICHTEN = 25000;

function veiligeNaam(tekst) {
  return String(tekst || "onbekend").replace(/[^a-zA-Z0-9._@-]/g, "_").slice(0, 120);
}

function bestandVoor(accountKey, folder) {
  return path.join(CACHE_DIR, `${veiligeNaam(accountKey)}__${veiligeNaam(folder)}.json`);
}

// ---------------------------------------------------------------------------
// DE MAILS BLIJVEN IN HET GEHEUGEN STAAN.
// ---------------------------------------------------------------------------
// Dit was DE reden dat alles zo traag aanvoelde. Elke keer als er iets van de
// mails nodig was — en dat gebeurt tientallen keren per aanvraag — werd het
// volledige bestand van schijf gelezen en ontleed. Bij 9000 mails is dat
// megabytes, en zolang dat bezig is staat de HELE server stil: geen enkele
// andere klik krijgt antwoord. Op de live server maten we zo 16,5 seconden
// voor een aanvraag die niets voorstelt.
//
// Nu staat elke map één keer in het geheugen. Lezen kost niets meer.
// Wegschrijven gebeurt vanaf nu ACHTER JE RUG, en hoogstens één keer per
// seconde per map — dus ook schrijven laat je nooit meer wachten.
const geheugen = new Map();          // "account__map" -> gegevens
const nogTeSchrijven = new Map();    // "account__map" -> timer

function sleutelVan(accountKey, folder) {
  return `${veiligeNaam(accountKey)}__${veiligeNaam(folder)}`;
}

// HOEVEEL MAPPEN ER TEGELIJK IN HET GEHEUGEN MOGEN STAAN.
// Dit was mijn eigen fout: ik zette élke map die ooit aangeraakt werd voorgoed
// in het geheugen. Op een servertje met 512 MB — met een inbox van duizenden
// mails plus Verzonden, Archief en Prullenmand — loopt dat vol. En een server
// die geheugen tekort komt, is nóg trager dan een server die van schijf leest.
// Twee mappen volstaan: je kijkt naar één map en de achtergrond werkt er één
// bij. De rest gaat gewoon terug naar schijf.
const MAX_MAPPEN_IN_GEHEUGEN = 3;

// DE INBOX BLIJFT ALTIJD IN HET GEHEUGEN STAAN.
// Dit was een dure fout. Er pasten maar twee mappen tegelijk in het geheugen,
// en op de achtergrond lopen je 102 mappen één voor één langs. Daardoor werd
// je INBOX er telkens weer uitgegooid, en moest die bij het eerstvolgende
// gebruik opnieuw van schijf gelezen en ontleed worden — een bestand met
// 11.688 mails. Bij het nakijken van de gelezen-status gebeurde dat zestig
// keer na elkaar: zestien seconden waarin de hele server stilstond. Dat zijn
// precies de haperingen die je voelde. De inbox is de map waar je altijd in
// zit; die blijft nu staan.
function isInbox(sleutel) {
  return /__INBOX$/i.test(sleutel);
}

function onthoud(sleutel, data) {
  // Wie het laatst gebruikt is, komt achteraan te staan.
  geheugen.delete(sleutel);
  geheugen.set(sleutel, data);
  while (geheugen.size > MAX_MAPPEN_IN_GEHEUGEN) {
    const oudste = [...geheugen.keys()].find((k) => k !== sleutel && !isInbox(k));
    if (!oudste) break;
    // Eerst nog wegschrijven wat in de wacht stond, anders raakt er iets kwijt.
    const wacht = nogTeSchrijven.get(oudste);
    if (wacht) {
      clearTimeout(wacht.timer);
      nogTeSchrijven.delete(oudste);
      naarSchijf(wacht.accountKey, wacht.folder, geheugen.get(oudste));
    }
    geheugen.delete(oudste);
  }
}

function lees(accountKey, folder) {
  const sleutel = sleutelVan(accountKey, folder);
  const bestaand = geheugen.get(sleutel);
  if (bestaand) { onthoud(sleutel, bestaand); return bestaand; }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(bestandVoor(accountKey, folder), "utf8"));
  } catch (e) {
    data = { uidValidity: null, mails: {}, bodies: {}, bijgewerkt: 0 };
  }
  onthoud(sleutel, data);
  return data;
}

function naarSchijf(accountKey, folder, data) {
  try {
    // NOOIT EEN VOLLE MAILBOX OVERSCHRIJVEN MET NIETS.
    // Lukt het inlezen van het bestand één keer niet (een half weggeschreven
    // bestand na een harde herstart bijvoorbeeld), dan begint de app met een
    // lege lijst — en die zou daarna over je échte, volle bestand geschreven
    // worden. Duizenden bewaarde mails weg, en alles opnieuw ophalen.
    // Dus: leeg wegschrijven mag alleen als er ook op schijf niets staat.
    const leeg = !data || !data.mails || Object.keys(data.mails).length === 0;
    if (leeg) {
      try {
        const bestaand = fs.statSync(bestandVoor(accountKey, folder));
        if (bestaand.size > 200) {
          console.error(`Lege maillijst voor ${folder} NIET weggeschreven — het bestaande bestand blijft staan.`);
          return;
        }
      } catch (e) { /* er staat nog niets, dus leeg mag */ }
    }
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Eerst naar een tijdelijk bestand en dan pas op zijn plaats zetten. Zo kan
    // een herstart middenin nooit een half bestand achterlaten.
    const doel = bestandVoor(accountKey, folder);
    const tijdelijk = doel + ".tmp";
    fs.writeFileSync(tijdelijk, JSON.stringify(data), "utf8");
    fs.renameSync(tijdelijk, doel);
  } catch (e) {
    console.error("Kon de mailcache niet wegschrijven:", e.message);
  }
}

// DEZELFDE SCHRIJFBEURT, MAAR DAN ZONDER DE APP STIL TE LEGGEN.
// Bij 11.000 mails is dit bestand tientallen megabytes. Dat in één keer
// omzetten en wegschrijven hield de server seconden bezig — en dan wacht jouw
// klik. Nu gebeurt het omzetten in stukken en het schrijven zelf achter de
// schermen, met een adempauze tussenin.
async function naarSchijfRustig(accountKey, folder, data) {
  try {
    const leeg = !data || !data.mails || Object.keys(data.mails).length === 0;
    if (leeg) {
      try {
        const bestaand = fs.statSync(bestandVoor(accountKey, folder));
        if (bestaand.size > 200) return;
      } catch (e) { /* er staat nog niets */ }
    }
    if (!fs.existsSync(CACHE_DIR)) await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    const doel = bestandVoor(accountKey, folder);
    const tijdelijk = doel + ".tmp";
    const tekst = JSON.stringify(data);
    await new Promise((r) => setImmediate(r));
    await fs.promises.writeFile(tijdelijk, tekst, "utf8");
    await fs.promises.rename(tijdelijk, doel);
  } catch (e) {
    console.error("Kon de mailcache niet wegschrijven:", e.message);
  }
}

function schrijf(accountKey, folder, data) {
  const sleutel = sleutelVan(accountKey, folder);
  onthoud(sleutel, data);
  if (nogTeSchrijven.has(sleutel)) return; // er komt al een schrijfbeurt aan
  // Drie seconden in plaats van één: tijdens het binnenhalen van duizenden
  // mails werd dit bestand anders elke seconde volledig herschreven.
  const timer = setTimeout(() => {
    nogTeSchrijven.delete(sleutel);
    naarSchijfRustig(accountKey, folder, geheugen.get(sleutel) || data);
  }, 3000);
  if (timer.unref) timer.unref(); // mag het afsluiten van de app niet tegenhouden
  nogTeSchrijven.set(sleutel, { timer, accountKey, folder });
}

// Alles wat nog in de wacht staat meteen wegschrijven. Gebeurt bij het
// afsluiten, zodat een herstart nooit de laatste seconde kwijtspeelt.
function flush() {
  for (const [sleutel, info] of [...nogTeSchrijven]) {
    clearTimeout(info.timer);
    nogTeSchrijven.delete(sleutel);
    const data = geheugen.get(sleutel);
    if (data) naarSchijf(info.accountKey, info.folder, data);
  }
}
for (const sein of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sein, () => {
    flush();
    if (sein !== "exit") process.exit(0);
  });
}

// Alle bewaarde mails van een map, nieuwste eerst.
// De gesorteerde lijst wordt onthouden: bij 9000 mails opnieuw sorteren bij elke
// opvraging is verspilde tijd, en er wordt véél vaker opgevraagd dan gewijzigd.
function getMails(accountKey, folder) {
  const data = lees(accountKey, folder);
  if (data._gesorteerd && data._gesorteerdOp === data.bijgewerkt) return data._gesorteerd;
  // De datum één keer omzetten in plaats van bij elke vergelijking opnieuw.
  // Bij 11.000 mails scheelt dat honderdduizenden omzettingen per sortering —
  // en dat was mee de reden dat de server af en toe seconden stilstond.
  const lijst = Object.values(data.mails || {});
  const tijden = new Map();
  for (const m of lijst) {
    const t = m && m.date ? Date.parse(m.date) : 0;
    tijden.set(m, Number.isFinite(t) ? t : 0);
  }
  lijst.sort((a, b) => tijden.get(b) - tijden.get(a));
  // Niet-opsombaar, zodat deze hulplijst nooit mee naar schijf geschreven wordt.
  Object.defineProperty(data, "_gesorteerd", { value: lijst, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(data, "_gesorteerdOp", { value: data.bijgewerkt, writable: true, configurable: true, enumerable: false });
  return lijst;
}

function getUidValidity(accountKey, folder) {
  return lees(accountKey, folder).uidValidity;
}

// Het hoogste uid dat we al kennen — alles daarboven is nieuw op de server.
function getHoogsteUid(accountKey, folder) {
  const data = lees(accountKey, folder);
  const uids = Object.keys(data.mails || {}).map(Number).filter((n) => !isNaN(n));
  return uids.length ? Math.max(...uids) : 0;
}

// Het laagste uid dat we hebben — alles daaronder moet nog opgehaald worden.
function getLaagsteUid(accountKey, folder) {
  const data = lees(accountKey, folder);
  const uids = Object.keys(data.mails || {}).map(Number).filter((n) => !isNaN(n));
  return uids.length ? Math.min(...uids) : 0;
}

// Onthoudt of we al helemaal tot bij de oudste mail geraakt zijn, zodat we
// niet elke keer opnieuw naar oudere berichten blijven zoeken.
function isVolledig(accountKey, folder) {
  return !!lees(accountKey, folder).volledig;
}

function markeerVolledig(accountKey, folder) {
  const data = lees(accountKey, folder);
  data.volledig = true;
  schrijf(accountKey, folder, data);
}

// Nieuwe of bijgewerkte kopregels bewaren.
function bewaarMails(accountKey, folder, mails, uidValidity) {
  if (!accountKey || !mails || !mails.length) return;
  const data = lees(accountKey, folder);
  if (uidValidity !== undefined && uidValidity !== null) data.uidValidity = uidValidity;
  for (const m of mails) {
    const bestaand = data.mails[m.uid] || {};
    data.mails[m.uid] = { ...bestaand, ...m };
  }
  data.bijgewerkt = Date.now();
  schrijf(accountKey, folder, data);
}

// Eén veld bijwerken (bv. gelezen/ongelezen) zonder de rest aan te raken.
function werkBij(accountKey, folder, uid, velden) {
  const data = lees(accountKey, folder);
  if (!data.mails[uid]) return;
  data.mails[uid] = { ...data.mails[uid], ...velden };
  data.bijgewerkt = Date.now();
  schrijf(accountKey, folder, data);
}

// Hetzelfde, maar voor een hele reeks tegelijk: ÉÉN keer lezen, ÉÉN keer
// wegschrijven. Het nakijken van de gelezen-status deed dit zestig keer na
// elkaar per mail, en elke keer kon dat een volledige map van schijf halen.
function werkBijVeel(accountKey, folder, paren) {
  if (!paren || !paren.length) return 0;
  const data = lees(accountKey, folder);
  let aantal = 0;
  for (const [uid, velden] of paren) {
    if (!data.mails[uid]) continue;
    data.mails[uid] = { ...data.mails[uid], ...velden };
    aantal++;
  }
  if (!aantal) return 0;
  data.bijgewerkt = Date.now();
  schrijf(accountKey, folder, data);
  return aantal;
}

// Mails die op de server niet meer bestaan (verplaatst of verwijderd) ook
// hier weghalen, zodat je lijst klopt.
function verwijderOntbrekende(accountKey, folder, bestaandeUids) {
  const data = lees(accountKey, folder);
  const houden = new Set(bestaandeUids.map(Number));
  let gewijzigd = false;
  for (const uid of Object.keys(data.mails)) {
    if (!houden.has(Number(uid))) {
      delete data.mails[uid];
      delete data.bodies[uid];
      gewijzigd = true;
    }
  }
  if (gewijzigd) { data.bijgewerkt = Date.now(); schrijf(accountKey, folder, data); }
  return gewijzigd;
}

function verwijderMail(accountKey, folder, uid) {
  const data = lees(accountKey, folder);
  delete data.mails[uid];
  delete data.bodies[uid];
  try {
    const pad = inhoudBestand(accountKey, folder, uid);
    fs.unlinkSync(pad);
    inhoudIndex().delete(path.basename(pad));
  } catch (e) { /* niet bewaard */ }
  data.bijgewerkt = Date.now();
  schrijf(accountKey, folder, data);
}

// ---------------------------------------------------------------------------
// De inhoud van mails — ELK IN EEN EIGEN BESTAND
// ---------------------------------------------------------------------------
// Bewust NIET samen met de kopregels in één groot bestand. Een mail met
// bijlagen is al gauw enkele megabytes; honderden daarvan in één JSON-bestand
// betekent dat de server dat hele bestand moet inlezen en wegschrijven telkens
// er ook maar één mail bijkomt. Dat maakt de app trager naarmate je hem meer
// gebruikt — precies het omgekeerde van wat je wil.
// Eén bestand per mail: openen en bewaren blijft even snel, of je er nu tien of
// duizend hebt.
const INHOUD_DIR = path.join(CACHE_DIR, "inhoud");

function inhoudBestand(accountKey, folder, uid) {
  return path.join(INHOUD_DIR, `${veiligeNaam(accountKey)}__${veiligeNaam(folder)}__${veiligeNaam(String(uid))}.json`);
}

// De inhoud van pas opgehaalde mails staat eerst in het geheugen en gaat daarna
// rustig naar schijf. Zo hoeft er nooit gewacht te worden op de schijf: bij het
// vooraf inladen van duizenden mails werden dat evenveel schrijfbeurten na
// elkaar, en daar stond de app seconden voor stil.
const versGeheugen = new Map();      // bestandspad -> inhoud
// Bewust klein gehouden. De server heeft maar 512 MB; honderden mailteksten in
// het geheugen houden zorgt voor opruimpauzes die je als haperingen voelt.
const MAX_VERS = 25;
const MAX_VERS_BYTES = 100000;

function bewaarBody(accountKey, folder, uid, body) {
  const pad = inhoudBestand(accountKey, folder, uid);
  const inhoud = { ...body, bewaardOp: Date.now() };
  inhoudIndex().add(path.basename(pad));
  // Alleen kleine berichten in het geheugen houden; een nieuwsbrief van een
  // halve megabyte hoort op schijf en nergens anders.
  const grootte = (inhoud.text || "").length + (inhoud.html || "").length;
  if (grootte < MAX_VERS_BYTES) versGeheugen.set(pad, inhoud);
  // Het geheugen niet laten vollopen: enkel de laatst bewaarde blijven hangen,
  // de rest staat dan toch al op schijf.
  if (versGeheugen.size > MAX_VERS) {
    const oudste = versGeheugen.keys().next().value;
    versGeheugen.delete(oudste);
  }
  (async () => {
    try {
      if (!fs.existsSync(INHOUD_DIR)) await fs.promises.mkdir(INHOUD_DIR, { recursive: true });
      await fs.promises.writeFile(pad, JSON.stringify(inhoud), "utf8");
    } catch (e) {
      console.error("Mailinhoud bewaren mislukt:", e.message);
    }
  })();
  ruimInhoudOp(accountKey);
}

// WELKE MAILS HEBBEN AL INHOUD OP SCHIJF?
// Dit werd tot nu nagegaan door het bestand écht in te lezen en te ontleden —
// voor elke mail opnieuw. Bij het zoeken naar "wat moet er nog ingeladen
// worden" gebeurde dat duizenden keren per portie, en werd het inladen trager
// naarmate er méér ingeladen was. Precies verkeerd om.
// Nu houden we één lijst bij van welke bestanden er zijn. Nakijken kost niets.
let bekendeInhoud = null;
function inhoudIndex() {
  if (bekendeInhoud) return bekendeInhoud;
  bekendeInhoud = new Set();
  try {
    for (const naam of fs.readdirSync(INHOUD_DIR)) bekendeInhoud.add(naam);
  } catch (e) { /* map bestaat nog niet */ }
  return bekendeInhoud;
}

function heeftBody(accountKey, folder, uid) {
  return inhoudIndex().has(path.basename(inhoudBestand(accountKey, folder, uid)));
}

function getBody(accountKey, folder, uid) {
  const pad = inhoudBestand(accountKey, folder, uid);
  // Net bewaard? Dan hoeft de schijf er niet aan te pas te komen.
  const vers = versGeheugen.get(pad);
  if (vers) return vers;
  try {
    return JSON.parse(fs.readFileSync(pad, "utf8"));
  } catch (e) {
    return null;
  }
}

// Niet oneindig laten aangroeien: de oudst bewaarde inhoud valt weg zodra we
// boven de grens komen. De mail zelf blijft gewoon in je mailbox staan; enkel
// de bewaarde kopie verdwijnt en wordt bij het openen opnieuw gehaald.
// DIT WAS EEN TWEEDE OORZAAK VAN DE HAPERINGEN.
// Deze opruiming vroeg van ELK bewaard bericht apart de datum op — bij 9000
// mails zijn dat 9000 schijfvragen na elkaar, en de server stond daar ruim vier
// seconden voor stil. Elke minuut opnieuw. En dat terwijl er meestal niets op
// te ruimen valt.
// Nu: eerst gewoon TELLEN (één schijfvraag). Zit je onder de grens — en dat is
// bijna altijd — dan gebeurt er verder niets. Moet er toch opgeruimd worden,
// dan gebeurt dat achter je rug, in kleine stukjes, zodat de app ondertussen
// gewoon blijft antwoorden.
let laatsteOpruim = 0;
let opruimBezig = false;
function ruimInhoudOp(accountKey) {
  // Hoogstens één keer per uur: opruimen heeft geen haast.
  if (Date.now() - laatsteOpruim < 3600000) return;
  if (opruimBezig) return;
  laatsteOpruim = Date.now();
  opruimBezig = true;
  (async () => {
    try {
      const voorvoegsel = veiligeNaam(accountKey) + "__";
      const namen = (await fs.promises.readdir(INHOUD_DIR)).filter((n) => n.startsWith(voorvoegsel));
      if (namen.length <= MAX_BEWAARDE_BERICHTEN) return;

      const bestanden = [];
      for (let i = 0; i < namen.length; i++) {
        const pad = path.join(INHOUD_DIR, namen[i]);
        let tijd = 0;
        try { tijd = (await fs.promises.stat(pad)).mtimeMs; } catch (e) { /* weg is weg */ }
        bestanden.push({ pad, tijd });
        // Om de honderd even de app laten ademen.
        if (i % 100 === 99) await new Promise((r) => setImmediate(r));
      }
      bestanden.sort((a, b) => a.tijd - b.tijd);
      const teveel = bestanden.slice(0, bestanden.length - MAX_BEWAARDE_BERICHTEN);
      for (let i = 0; i < teveel.length; i++) {
        try { await fs.promises.unlink(teveel[i].pad); } catch (e) { /* al weg */ }
        if (i % 100 === 99) await new Promise((r) => setImmediate(r));
      }
    } catch (e) { /* map bestaat nog niet */ }
    finally { opruimBezig = false; }
  })();
}

// Alles van een map weggooien — bij een uidValidity-wissel of als de
// gebruiker opnieuw wil beginnen.
function wisMap(accountKey, folder) {
  try {
    fs.unlinkSync(bestandVoor(accountKey, folder));
  } catch (e) { /* bestond nog niet */ }
}

function statistiek(accountKey, folder) {
  const data = lees(accountKey, folder);
  return {
    aantal: Object.keys(data.mails || {}).length,
    bewaardeBerichten: Object.keys(data.bodies || {}).length,
    bijgewerkt: data.bijgewerkt || 0,
  };
}

// Hoeveel mails van een map hebben hun INHOUD al op schijf staan? Dat is de
// vraag "zijn mijn oude mails al ingeladen?" — het antwoord in cijfers.
function inhoudVoortgang(accountKey, folder) {
  const uids = Object.keys(lees(accountKey, folder).mails || {});
  let klaar = 0;
  for (const uid of uids) {
    if (heeftBody(accountKey, folder, uid)) klaar++;
  }
  return { totaal: uids.length, klaar };
}

// Alle mappen waarvan we mails bewaard hebben. Nodig om over de hele bewaarde
// mailbox te kunnen zoeken zonder de mailserver lastig te vallen.
function getMappen(accountKey) {
  try {
    const voorvoegsel = veiligeNaam(accountKey) + "__";
    return fs.readdirSync(CACHE_DIR)
      .filter((naam) => naam.startsWith(voorvoegsel) && naam.endsWith(".json"))
      .map((naam) => naam.slice(voorvoegsel.length, -5));
  } catch (e) {
    return [];
  }
}

module.exports = {
  flush,
  heeftBody,
  inhoudVoortgang,
  getMappen,
  getMails,
  getUidValidity,
  getHoogsteUid,
  getLaagsteUid,
  isVolledig,
  markeerVolledig,
  bewaarMails,
  werkBij,
  werkBijVeel,
  verwijderOntbrekende,
  verwijderMail,
  bewaarBody,
  getBody,
  wisMap,
  statistiek,
};
