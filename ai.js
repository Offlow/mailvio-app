// ai.js — praat met de Claude API voor classificatie, antwoordvoorstellen en de chat.
const Anthropic = require("@anthropic-ai/sdk");
const settings = require("./settings");
const mailbox = require("./mailbox");

function isConfigured() {
  return !!settings.getConfig().anthropicApiKey;
}

function client() {
  const c = settings.getConfig();
  const opties = { apiKey: c.anthropicApiKey };
  // Een identity-linked sleutel werkt enkel mét het workspace-id erbij.
  if (c.anthropicWorkspaceId) {
    opties.defaultHeaders = { "anthropic-workspace-id": c.anthropicWorkspaceId };
  }
  return new Anthropic(opties);
}

// Zet een technische API-fout om in iets waar je wat aan hebt. Zo verdwijnt een
// probleem nooit meer stil in de logs.
function leesbareAiFout(e) {
  const bericht = String((e && e.message) || e || "");
  if (/anthropic-workspace-id/i.test(bericht)) {
    return "Je API-sleutel hoort bij een workspace. Vul bij Instellingen \u2192 AI-instellingen je workspace-id in (te vinden in console.anthropic.com bij Settings \u2192 Workspaces), of maak daar een gewone API-sleutel aan zonder workspace.";
  }
  if (/authentication|invalid x-api-key|401/i.test(bericht)) return "Je API-sleutel wordt niet aanvaard. Kijk hem na bij Instellingen.";
  if (/credit|billing|quota|402/i.test(bericht)) return "Je API-tegoed is op. Vul aan bij console.anthropic.com.";
  if (/429|rate.?limit/i.test(bericht)) return "Te veel aanvragen na elkaar. Probeer over een minuut opnieuw.";
  if (/model/i.test(bericht) && /not_found|does not exist/i.test(bericht)) return "Het ingestelde AI-model bestaat niet. Kijk het na bij Instellingen \u2192 Welk AI-model.";
  return bericht.slice(0, 250);
}

// De laatste AI-fout, zodat de app ze kan tonen in plaats van ze te verzwijgen.
let laatsteFout = null;
function onthoudFout(e) {
  laatsteFout = { uitleg: leesbareAiFout(e), op: Date.now() };
  return laatsteFout;
}
function getLaatsteFout() {
  return laatsteFout;
}
function wisFout() {
  laatsteFout = null;
}

// Twee modellen, elk voor hun werk.
//  - SNEL: het beoordelen van mails. Dat gebeurt voor élke mail, dus daar telt
//    snelheid en prijs. Een klein model volstaat ruim om te zien of iets een
//    offerte, een factuur of reclame is.
//  - SLIM: antwoorden schrijven, je vragen beantwoorden, bijlagen en klanten
//    samenvatten. Daar wil je wel het betere model.
function modelSnel() {
  return settings.getConfig().aiModelSnel || "claude-haiku-4-5";
}
function modelSlim() {
  return settings.getConfig().aiModelSlim || "claude-sonnet-5";
}

// Werkt dit model met jouw sleutel? Geeft een duidelijke uitleg terug in plaats
// van een technische foutmelding.
async function testModel(naam) {
  if (!isConfigured()) return { ok: false, uitleg: "Vul eerst je API-sleutel in." };
  try {
    await client().messages.create({
      model: String(naam || "").trim(),
      max_tokens: 8,
      messages: [{ role: "user", content: "ok" }],
    });
    return { ok: true, uitleg: "Werkt." };
  } catch (e) {
    const bericht = String(e && e.message ? e.message : e);
    if (/model/i.test(bericht) && /not_found|does not exist|invalid/i.test(bericht)) {
      return { ok: false, uitleg: "Dit model bestaat niet of is niet beschikbaar met jouw sleutel." };
    }
    if (/authentication|api.?key|401/i.test(bericht)) {
      return { ok: false, uitleg: "Je API-sleutel wordt niet aanvaard." };
    }
    if (/credit|billing|quota|402|429/i.test(bericht)) {
      return { ok: false, uitleg: "Je API-tegoed is op of je zit aan een limiet." };
    }
    return { ok: false, uitleg: bericht.slice(0, 200) };
  }
}

function extractJson(text, fallback) {
  try {
    const match = text.match(/[[{][\s\S]*[\]}]/);
    return JSON.parse(match ? match[0] : text);
  } catch (e) {
    return fallback;
  }
}

const CLASSIFY_SYSTEM = `Je bent de AI-assistent van Mailvio, een persoonlijke mailapp voor een zelfstandige dakwerker in Vlaanderen.
Je krijgt een lijst van recente mails. Beoordeel per mail hoe dringend die is, wie de afzender waarschijnlijk is, en welke actie nodig is — puur op basis van de inhoud (niet op basis van gelezen/ongelezen).

Gebruik exact een van deze categorieën:
- "dringend": vraagt vandaag nog een reactie (bv. een klacht, een klant die dringend iets nodig heeft)
- "vandaag": zou vandaag beantwoord moeten worden (bv. een offertevraag, een planningsvraag)
- "binnenkort": kan nog een paar dagen wachten (bv. een leverancier zonder directe vraag)
- "geen_actie": geen antwoord nodig (bv. reclame, nieuwsbrief, bevestiging, bedankmail)

Gebruik voor "vanType" exact een van: "klant", "leverancier", "onbekend".
Geef in "actieLabel" een kort werkwoord van max 2 woorden in het Vlaams voor de actieknop (bv. "Beantwoorden", "Opstellen", "Bevestigen", "Voorstel doen", "Opvolgen") — enkel als een actie nodig is, anders "".

Bepaal ook waarover de mail gaat, met "soort" — exact een van:
- "offerte": een prijsvraag, offerte, prijsbestek of bestelling
- "afspraak": een datum, plaatsbezoek, planning of afspraak die vastgelegd of bevestigd moet worden
- "factuur": een factuur, betaling, herinnering of boekhouding
- "reclame": nieuwsbrief, promotie of ongevraagde reclame
- "overig": al de rest

Zet "belangrijk" op true bij een mail die hij echt niet mag missen: een klacht, een schadegeval, een deadline, een betwisting of een klant die dreigt af te haken. Anders false.

ABSOLUTE VOORRANG — aanvragen via zijn eigen website (daklo.be):
Komt een mail binnen via het contact- of offerteformulier van zijn website, dan is dat een verse klantaanvraag en die is ALTIJD het belangrijkst. Herken dat aan zaken als: een afzender of onderwerp met "daklo", "contactformulier", "offerteaanvraag", "nieuw bericht via de website", "aanvraag via website", een automatische formuliermail met velden zoals naam/telefoon/adres/bericht, of een verzendend systeem (WordPress, noreply, wpforms, formulier).
Zet dan "viaWebsite" op true, "categorie" op "dringend", "vanType" op "klant" en "belangrijk" op true. Nooit "geen_actie". Anders "viaWebsite": false.

RECLAME BIJ TWIJFEL:
Ben je er niet zeker van of iets reclame is dan wel een echte mail die een antwoord verdient — bijvoorbeeld een leverancier die zowel nieuws als een aanbieding stuurt — zet dan "reclameTwijfel" op true. Bij duidelijke gevallen (overduidelijke nieuwsbrief, of overduidelijk een echte klantvraag) zet je "reclameTwijfel" op false.

Antwoord ALLEEN met geldige JSON, een array van objecten:
[{"uid": <uid>, "categorie": "...", "reden": "korte reden in het Vlaams, max 12 woorden", "vanType": "...", "actieLabel": "...", "soort": "...", "belangrijk": true, "viaWebsite": false, "reclameTwijfel": false}]
Geen andere tekst.`;

async function classifyMails(mails) {
  if (!isConfigured() || mails.length === 0) return [];
  const anthropic = client();
  const input = mails.map((m) => ({
    uid: m.uid,
    van: m.from,
    onderwerp: m.subject,
    fragment: m.snippet,
  }));

  const resp = await anthropic.messages.create({
    model: modelSnel(),
    max_tokens: 1536,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });

  const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return extractJson(text, []);
}

function suggestSystem(toon, handtekening) {
  return `Je bent de AI-assistent van Mailvio, een persoonlijke mailapp voor een zelfstandige dakwerker in Vlaanderen (bedrijf: Daklo).
Je krijgt één mail. Analyseer ze kort en stel een antwoord voor, in deze schrijfstijl/toon: "${toon}". Onderteken het antwoord met "${handtekening}".

Antwoord ALLEEN met geldige JSON in dit formaat, geen andere tekst:
{
  "type": "korte omschrijving, bv. klantvraag - opvolging van eerdere herstelling",
  "actie": "wat er moet gebeuren, bv. antwoord vereist",
  "urgentie": "bv. normaal, wel deze week",
  "samenvatting": "1-3 zinnen in het Vlaams die uitleggen wat Mailvio voorstelt en waarom",
  "antwoord": "het volledige voorgestelde antwoord, met aanhef en groet"
}`;
}

async function suggestReply(mail) {
  if (!isConfigured()) {
    throw new Error("De AI is nog niet ingesteld.");
  }
  const config = settings.getConfig();
  const toon = config.aiToon || "Vlaams, kort en professioneel";
  const handtekening = config.aiHandtekening || config.displayName?.split(" ")[0] || "Silvio";
  const anthropic = client();
  const resp = await anthropic.messages.create({
    model: modelSlim(),
    max_tokens: 1024,
    system: suggestSystem(toon, handtekening),
    messages: [
      {
        role: "user",
        content: `Van: ${mail.from} <${mail.fromAddress}>\nOnderwerp: ${mail.subject}\n\n${mail.text || mail.snippet || ""}`,
      },
    ],
  });
  const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return extractJson(text, {
    type: "",
    actie: "",
    urgentie: "",
    samenvatting: "Kon geen voorstel opstellen.",
    antwoord: "",
  });
}

// Haalt uit een mail de gegevens van een afspraak: wat, wanneer, waar.
const AFSPRAAK_SYSTEM = `Je haalt uit een mail de gegevens van een afspraak voor een zelfstandige dakwerker in Vlaanderen.
Vandaag is {VANDAAG}. Reken relatieve dagen ("volgende dinsdag", "morgen") om naar een echte datum.

Antwoord ALLEEN met geldige JSON:
{
  "gevonden": true of false,
  "titel": "korte titel, bv. Plaatsbezoek dak Peeters",
  "datum": "JJJJ-MM-DD",
  "begin": "UU:MM" (of "" als er geen uur vermeld staat),
  "duur": aantal minuten (standaard 60),
  "plaats": "adres of plaats, of lege tekst",
  "notitie": "1 zin met waarover het gaat"
}
Zet "gevonden" op false als er echt geen afspraak of datum in de mail staat.
Geen andere tekst.`;

async function extractAfspraak(mail) {
  if (!isConfigured()) throw new Error("De AI is nog niet ingesteld.");
  const anthropic = client();
  const vandaag = new Date().toLocaleDateString("nl-BE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const resp = await anthropic.messages.create({
    model: modelSlim(),
    max_tokens: 512,
    system: AFSPRAAK_SYSTEM.replace("{VANDAAG}", vandaag),
    messages: [
      {
        role: "user",
        content: `Van: ${mail.from} <${mail.fromAddress}>\nOnderwerp: ${mail.subject}\n\n${(mail.text || mail.snippet || "").slice(0, 4000)}`,
      },
    ],
  });
  const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return extractJson(text, { gevonden: false });
}

// ---------------------------------------------------------------------------
// Bijlage in twee zinnen samenvatten
// ---------------------------------------------------------------------------
// Claude kan een PDF of een foto rechtstreeks lezen. Voor gewone tekstbestanden
// (txt, csv, ...) sturen we de tekst mee. Voor formaten die we niet kunnen
// openen (bv. Word of Excel) geven we eerlijk terug dat we ze niet konden lezen,
// in plaats van iets te verzinnen.
const BIJLAGE_SYSTEM = `Je bent de assistent van een zelfstandige dakwerker in Vlaanderen.
Je krijgt één bijlage uit een e-mail. Vat ze samen in PRECIES TWEE zinnen, in het Nederlands (Vlaams, zakelijk, geen jij-vorm nodig).
Zin 1: wat voor document het is en waarover het gaat.
Zin 2: het belangrijkste concrete gegeven eruit (bedrag, datum, adres, aantal, wat er gevraagd wordt).
Regels:
- Verzin NOOIT gegevens. Staat er geen bedrag of datum in, benoem dan iets anders dat er wel staat.
- Geen inleiding, geen opsomming, geen kopjes. Enkel de twee zinnen.
- Bij een foto: beschrijf wat er te zien is en wat dat betekent voor een dakwerker.`;

const TEKST_TYPES = /^(text\/|application\/(json|xml|csv))/i;

async function vatBijlageSamen(bijlage) {
  if (!isConfigured()) throw new Error("De AI is nog niet ingesteld.");
  const type = String(bijlage.contentType || "").toLowerCase();
  const naam = bijlage.filename || "bijlage";
  const buffer = Buffer.isBuffer(bijlage.content) ? bijlage.content : Buffer.from(bijlage.content || "");

  // Te groot om door te sturen? Dan liever niets dan een halve samenvatting.
  const MAX_BYTES = 8 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    return { samenvatting: "", reden: "Deze bijlage is te groot om automatisch samen te vatten." };
  }

  let inhoud = null;
  if (type.startsWith("application/pdf") || /\.pdf$/i.test(naam)) {
    inhoud = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } },
    ];
  } else if (/^image\/(png|jpeg|gif|webp)$/.test(type)) {
    inhoud = [{ type: "image", source: { type: "base64", media_type: type, data: buffer.toString("base64") } }];
  } else if (TEKST_TYPES.test(type) || /\.(txt|csv|md|json|xml)$/i.test(naam)) {
    const tekst = buffer.toString("utf8").slice(0, 20000).trim();
    if (!tekst) return { samenvatting: "", reden: "Deze bijlage is leeg." };
    inhoud = [{ type: "text", text: tekst }];
  } else {
    return { samenvatting: "", reden: "Dit bestandstype kan Mailvio (nog) niet zelf openen." };
  }

  const resp = await client().messages.create({
    model: modelSlim(),
    max_tokens: 300,
    system: BIJLAGE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [...inhoud, { type: "text", text: `Bestandsnaam: ${naam}. Vat deze bijlage samen in twee zinnen.` }],
      },
    ],
  });
  const tekst = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  return { samenvatting: tekst, reden: "" };
}

// Een korte klantsamenvatting voor de klantenfiche: wie is dit, wat loopt er,
// waar moet je op letten. Enkel op basis van de mails die er effectief zijn.
const KLANT_SYSTEM = `Je bent de assistent van een zelfstandige dakwerker in Vlaanderen.
Je krijgt de mailgeschiedenis met één contactpersoon. Haal daar de klantgegevens uit.

Antwoord met ENKEL geldige JSON, in deze vorm:
{
  "samenvatting": "max 3 korte zinnen: wie dit is en wat voor werk het betreft, wat er tot nu gebeurd is, en waar hij nu op moet letten",
  "bedrijf": "de bedrijfsnaam als het over een bedrijf gaat, anders \"\"",
  "contactpersonen": [{"naam": "...", "rol": "bv. zaakvoerder, boekhouding, werfleider", "telefoon": "", "email": ""}],
  "telefoons": ["telefoonnummers die in de mails staan"],
  "adressen": ["werf- of factuuradressen die in de mails staan"],
  "aandachtspunten": ["korte punten om te onthouden, bv. 'wil enkel na 17u gebeld worden', 'poort links achteraan'"]
}

Regels:
- Verzin NOOIT gegevens. Staat iets niet in de mails, laat het weg of gebruik een lege lijst.
- Neem GEEN gegevens over van de dakwerker zelf (Daklo, info@daklo.be) — enkel van de contactpersoon.
- Haal contactpersonen uit ondertekeningen en aanspreektitels ("Beste Jan", "Met vriendelijke groeten, Peter Van Damme").
- Hoogstens 4 contactpersonen, 4 telefoons, 3 adressen en 4 aandachtspunten.
- Schrijf in het Nederlands (Vlaams, zakelijk).`;

async function vatKlantSamen(adres, mails) {
  if (!isConfigured()) throw new Error("De AI is nog niet ingesteld.");
  const regels = mails
    .map((m) => `- ${m.date ? new Date(m.date).toLocaleDateString("nl-BE") : "?"} — ${m.subject || "(geen onderwerp)"}${m.snippet ? ": " + String(m.snippet).slice(0, 600) : ""}`)
    .join("\n");
  const resp = await client().messages.create({
    model: modelSlim(),
    max_tokens: 900,
    system: KLANT_SYSTEM,
    messages: [{ role: "user", content: `Contactpersoon: ${adres}\n\nMailgeschiedenis (nieuwste eerst):\n${regels}` }],
  });
  const tekst = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const data = extractJson(tekst, {});
  return {
    samenvatting: String(data.samenvatting || "").trim(),
    bedrijf: String(data.bedrijf || "").trim(),
    contactpersonen: Array.isArray(data.contactpersonen) ? data.contactpersonen.slice(0, 4) : [],
    telefoons: Array.isArray(data.telefoons) ? data.telefoons.slice(0, 4).map(String) : [],
    adressen: Array.isArray(data.adressen) ? data.adressen.slice(0, 3).map(String) : [],
    aandachtspunten: Array.isArray(data.aandachtspunten) ? data.aandachtspunten.slice(0, 4).map(String) : [],
  };
}

// Uit een zin in gewone taal een automatiseringsregel maken.
// "alles van bpost mag naar reclame" wordt: als afzender bevat "bpost" → reclame.
const REGEL_SYSTEM = `Je zet een wens van een zelfstandige dakwerker om in één automatiseringsregel voor zijn mailapp.

Antwoord met ENKEL geldige JSON:
{
  "gelukt": true,
  "naam": "korte omschrijving in het Nederlands, bv. 'Nieuwsbrieven van bpost naar Reclame'",
  "veld": "afzender" | "onderwerp" | "inhoud" | "soort",
  "test": "bevat" | "is" | "begint_met",
  "waarde": "waar de regel op reageert",
  "acties": ["reclame" | "belangrijk" | "dringend" | "geen_actie" | "taak" | "niet_opvolgen"],
  "uitleg": "één zin die aan de gebruiker uitlegt wat deze regel zal doen"
}

Wat de acties betekenen:
- "reclame": de mail gaat naar de map Reclame en telt niet meer mee als post
- "belangrijk": de mail wordt als belangrijk gemarkeerd
- "dringend": de mail komt bij "Actie nodig"
- "geen_actie": er hoeft niet op geantwoord te worden
- "taak": er wordt automatisch een to-do van gemaakt
- "niet_opvolgen": de mail telt niet meer mee als openstaande zaak

Voor "veld" is "soort" enkel bruikbaar met waarde "offerte", "afspraak", "factuur", "reclame" of "overig".

Kan je er geen zinnige regel van maken, antwoord dan:
{"gelukt": false, "uitleg": "vraag in één zin wat je nog nodig hebt"}`;

async function stelRegelVoor(beschrijving) {
  if (!isConfigured()) throw new Error("De AI is nog niet ingesteld.");
  const resp = await client().messages.create({
    model: modelSlim(),
    max_tokens: 500,
    system: REGEL_SYSTEM,
    messages: [{ role: "user", content: String(beschrijving || "").slice(0, 1000) }],
  });
  const tekst = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return extractJson(tekst, { gelukt: false, uitleg: "Ik kon er geen regel van maken. Probeer het wat concreter te omschrijven." });
}

async function rewriteProfessional(text) {
  if (!isConfigured()) {
    throw new Error("De AI is nog niet ingesteld.");
  }
  const config = settings.getConfig();
  const toon = config.aiToon || "Vlaams, kort en professioneel";
  const anthropic = client();
  const resp = await anthropic.messages.create({
    model: modelSlim(),
    max_tokens: 1024,
    system: `Je herschrijft mailteksten korter en in deze schrijfstijl/toon: "${toon}", zonder de betekenis te veranderen. Antwoord alleen met de herschreven tekst, geen andere uitleg.`,
    messages: [{ role: "user", content: text }],
  });
  return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

const CHAT_SYSTEM = `Je bent de AI-assistent in Mailvio, een persoonlijke mailapp voor een zelfstandige dakwerker in Vlaanderen.
Je krijgt zijn mailbox mee ZOALS MAILVIO ZE AL BEOORDEELD HEEFT: per mail staat er wie de afzender is, het onderwerp, hoe oud ze is, hoe dringend, welk soort (offerte, afspraak, factuur) en of ze belangrijk is.

BEANTWOORD DE VRAAG UIT DIE LIJST. Dat is bijna altijd genoeg, en het gaat meteen. Gebruik "zoek_mailbox" ENKEL als de vraag over iets gaat dat er zeker niet in staat — bv. een mail van vorig jaar of een naam die nergens in de lijst voorkomt. Zoeken duurt lang, dus doe het niet "voor de zekerheid".

Antwoord concreet en met namen erbij. Vraagt hij welke offertes openstaan, som dan de afzenders en onderwerpen op met hoe lang ze al wachten, en zeg wat er zou moeten gebeuren. Geen algemeenheden. Gebruik het gereedschap "zoek_mailbox" telkens de vraag mogelijk over een mail gaat die niet in die recente lijst staat — bv. een naam, bedrijf, oud onderwerp, "wanneer heb ik met X gemaild", of gewoon wanneer je het niet zeker weet. Zoek liever één keer te veel dan een verkeerd of onvolledig antwoord te geven.
Beantwoord de vraag kort, direct en vriendelijk in het Vlaams — geen lange uitleg, geen jargon.
Als je een mail voorstelt te herschrijven of te beantwoorden, schrijf die dan meteen kort en professioneel uit.`;

const SEARCH_TOOL = {
  name: "zoek_mailbox",
  description: "Doorzoekt ALLE gekoppelde mailboxen (dus ook de boekhoudingmailbox, niet enkel de mailbox waar de gebruiker nu in werkt) op een zoekterm in onderwerp, afzender of inhoud. Gebruik dit telkens het antwoord mogelijk niet in de meegegeven recente mails staat.",
  input_schema: {
    type: "object",
    properties: {
      zoekterm: { type: "string", description: "Zoekterm: een naam, bedrijfsnaam, e-mailadres of onderwerp." },
    },
    required: ["zoekterm"],
  },
};

// Zoekt over ALLE gekoppelde mailboxen heen — dus ook in de boekhoudingmailbox
// terwijl je in info@ aan het werken bent. Bij elk resultaat staat uit welke
// mailbox het komt, zodat het antwoord dat kan vermelden.
async function runMailboxSearch(zoekterm) {
  try {
    const { mails } = await mailbox.searchAlleMailboxen(zoekterm, 15);
    if (!mails.length) return `Geen mails gevonden voor "${zoekterm}".`;
    return mails
      .slice(0, 40)
      .map((m) => `- (uid ${m.uid}${m.mailbox ? ", mailbox: " + m.mailbox : ""}) Van: ${m.from} <${m.fromAddress}> | Onderwerp: ${m.subject} | ${m.date ? new Date(m.date).toLocaleDateString("nl-BE") : "?"} | ${m.snippet || ""}`)
      .join("\n");
  } catch (e) {
    return "Zoeken in de mailbox is mislukt: " + e.message;
  }
}

// De chat kan de VOLLEDIGE mailbox doorzoeken via het "zoek_mailbox"-gereedschap
// (agentic tool-use, in maximaal MAX_TOOL_ROUNDS rondes) — de meegegeven
// "mails"-context is enkel een snelle samenvatting van de recentste berichten,
// geen harde grens op wat de AI kan beantwoorden.
async function chat(message, mails) {
  if (!isConfigured()) {
    return "De AI is nog niet ingesteld — vul je Claude API-sleutel in bij de instellingen.";
  }
  const anthropic = client();

  // Alles wat Mailvio al beoordeeld heeft, gaat MEE als context. Zo hoeft er
  // voor een gewone vraag ("welke offertes moet ik opvolgen?") niet eerst in de
  // mailbox gezocht te worden — dat duurde seconden. Nu staat het antwoord er
  // vrijwel meteen, omdat de beoordeling al op de achtergrond gebeurd is.
  const OPEN_LIMIET = 220;   // openstaande zaken: die zijn het belangrijkst
  const RECENT_LIMIET = 80;  // plus de recentste van de rest, voor context

  const nieuwste = (a, b) => new Date(b.date) - new Date(a.date);
  const alles = [...mails].sort(nieuwste);

  const isOpen = (m) =>
    !m.resolved && !m.genegeerd && m.soort !== "reclame" &&
    m.categorie && m.categorie !== "geen_actie" && m.categorie !== "onbekend";

  const beoordeeld = alles.filter((m) => m.categorie && m.categorie !== "onbekend").length;
  const open = alles.filter(isOpen).slice(0, OPEN_LIMIET);
  const openUids = new Set(open.map((m) => m.uid));
  const rest = alles.filter((m) => !openUids.has(m.uid) && m.soort !== "reclame").slice(0, RECENT_LIMIET);

  const regel = (m) => {
    const dagen = m.date ? Math.floor((Date.now() - new Date(m.date)) / 86400000) : null;
    const stukken = [
      `uid ${m.uid}`,
      m.from,
      m.subject || "(geen onderwerp)",
      m.date ? new Date(m.date).toLocaleDateString("nl-BE") : "?",
      dagen !== null ? `${dagen}d geleden` : "",
      m.categorie && m.categorie !== "onbekend" ? m.categorie : "",
      m.soort && m.soort !== "overig" ? m.soort : "",
      m.vanType && m.vanType !== "onbekend" ? m.vanType : "",
      m.belangrijk ? "belangrijk" : "",
      m.viaWebsite ? "via daklo.be" : "",
      m.unread ? "ongelezen" : "",
    ].filter(Boolean);
    return `- ${stukken.join(" | ")}${m.snippet ? ` :: ${String(m.snippet).slice(0, 160)}` : ""}`;
  };

  const context = [
    `OPENSTAANDE ZAKEN (${open.length} van ${alles.filter(isOpen).length}) — hier gaat het meestal over:`,
    open.map(regel).join("\n") || "(niets openstaand)",
    "",
    `RECENTE AFGEHANDELDE OF NIET-DRINGENDE MAILS (${rest.length}):`,
    rest.map(regel).join("\n") || "(geen)",
  ].join("\n");

  const vandaag = new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const messages = [
    {
      role: "user",
      content: `Vandaag is het ${vandaag}. Hieronder staat de mailbox zoals Mailvio ze al beoordeeld heeft (${beoordeeld} van ${alles.length} mails beoordeeld).${beoordeeld === 0 ? " LET OP: er is nog GEEN ENKELE mail beoordeeld — zeg dat eerlijk in plaats van te gokken." : ""}\n\n${context}\n\nVraag van de dakwerker: ${message}`,
    },
  ];

  // Eén zoekronde blijft mogelijk voor iets dat écht niet in de lijst staat
  // (bv. "wanneer heb ik vorig jaar met die klant gemaild"), maar de gewone
  // vraag wordt meteen uit de context beantwoord.
  // Eén zoekronde blijft mogelijk voor iets dat écht niet in de lijst staat.
  // BELANGRIJK: in de LAATSTE ronde bieden we het zoekgereedschap NIET meer aan.
  // Anders kan de AI opnieuw willen zoeken in plaats van te antwoorden, en dan
  // kwam er letterlijk niets terug — dat was de "Geen antwoord ontvangen".
  const MAX_TOOL_ROUNDS = 2;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const laatsteRonde = round === MAX_TOOL_ROUNDS;
    let resp;
    try {
      resp = await anthropic.messages.create({
        model: modelSlim(),
        max_tokens: 1024,
        system: CHAT_SYSTEM,
        ...(laatsteRonde ? {} : { tools: [SEARCH_TOOL] }),
        messages,
      });
    } catch (e) {
      onthoudFout(e);
      return "Er ging iets mis: " + leesbareAiFout(e);
    }

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (!toolUses.length) {
      const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      if (text) return text;
      // Nog steeds niets? Dan zeggen we tenminste eerlijk wat er aan de hand is
      // in plaats van een lege doos.
      return beoordeeld === 0
        ? "Ik kan je hier nog niet mee helpen: geen enkele mail is al door de AI beoordeeld. Kijk het lampje onderaan de zijbalk na — daar staat wat er scheelt."
        : "Ik kreeg geen antwoord van de AI. Probeer het nog eens.";
    }

    messages.push({ role: "assistant", content: resp.content });
    const toolResults = [];
    for (const use of toolUses) {
      const resultText = await runMailboxSearch(use.input?.zoekterm || "");
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: resultText });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return beoordeeld === 0
    ? "Ik kan je hier nog niet mee helpen: geen enkele mail is al door de AI beoordeeld. Kijk het lampje onderaan de zijbalk na — daar staat wat er scheelt."
    : "Ik kreeg geen antwoord van de AI. Probeer het nog eens.";
}

module.exports = { classifyMails, suggestReply, rewriteProfessional, chat, isConfigured, extractAfspraak, vatBijlageSamen, vatKlantSamen, stelRegelVoor, testModel, leesbareAiFout, getLaatsteFout, wisFout, onthoudFout };
