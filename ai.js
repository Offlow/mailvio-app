// ai.js — praat met de Claude API voor classificatie, antwoordvoorstellen en de chat.
const Anthropic = require("@anthropic-ai/sdk");
const settings = require("./settings");
const mailbox = require("./mailbox");

function isConfigured() {
  return !!settings.getConfig().anthropicApiKey;
}

function client() {
  return new Anthropic({ apiKey: settings.getConfig().anthropicApiKey });
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

Antwoord ALLEEN met geldige JSON, een array van objecten:
[{"uid": <uid>, "categorie": "...", "reden": "korte reden in het Vlaams, max 12 woorden", "vanType": "...", "actieLabel": "...", "soort": "...", "belangrijk": true}]
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
    model: "claude-sonnet-5",
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
    model: "claude-sonnet-5",
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
    model: "claude-sonnet-5",
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

async function rewriteProfessional(text) {
  if (!isConfigured()) {
    throw new Error("De AI is nog niet ingesteld.");
  }
  const config = settings.getConfig();
  const toon = config.aiToon || "Vlaams, kort en professioneel";
  const anthropic = client();
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: `Je herschrijft mailteksten korter en in deze schrijfstijl/toon: "${toon}", zonder de betekenis te veranderen. Antwoord alleen met de herschreven tekst, geen andere uitleg.`,
    messages: [{ role: "user", content: text }],
  });
  return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

const CHAT_SYSTEM = `Je bent de AI-assistent in Mailvio, een persoonlijke mailapp voor een zelfstandige dakwerker in Vlaanderen.
Je krijgt de recentste mails uit zijn mailbox als context, maar dat is niet per se de hele mailbox. Gebruik het gereedschap "zoek_mailbox" telkens de vraag mogelijk over een mail gaat die niet in die recente lijst staat — bv. een naam, bedrijf, oud onderwerp, "wanneer heb ik met X gemaild", of gewoon wanneer je het niet zeker weet. Zoek liever één keer te veel dan een verkeerd of onvolledig antwoord te geven.
Beantwoord de vraag kort, direct en vriendelijk in het Vlaams — geen lange uitleg, geen jargon.
Als je een mail voorstelt te herschrijven of te beantwoorden, schrijf die dan meteen kort en professioneel uit.`;

const SEARCH_TOOL = {
  name: "zoek_mailbox",
  description: "Doorzoekt de VOLLEDIGE mailbox (niet enkel de recentste mails die je als context kreeg) op een zoekterm in onderwerp, afzender of inhoud. Gebruik dit telkens het antwoord mogelijk niet in de meegegeven recente mails staat.",
  input_schema: {
    type: "object",
    properties: {
      zoekterm: { type: "string", description: "Zoekterm: een naam, bedrijfsnaam, e-mailadres of onderwerp." },
    },
    required: ["zoekterm"],
  },
};

async function runMailboxSearch(zoekterm) {
  try {
    const { mails } = await mailbox.searchMails(zoekterm, 20);
    if (!mails.length) return `Geen mails gevonden voor "${zoekterm}".`;
    return mails
      .map((m) => `- (uid ${m.uid}) Van: ${m.from} <${m.fromAddress}> | Onderwerp: ${m.subject} | ${new Date(m.date).toLocaleDateString("nl-BE")} | ${m.snippet}`)
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
  const CHAT_CONTEXT_LIMIT = 60;
  const recentMails = [...mails].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, CHAT_CONTEXT_LIMIT);
  const mailContext = recentMails
    .map((m) => `- (uid ${m.uid}) Van: ${m.from} | Onderwerp: ${m.subject} | ${m.unread ? "ongelezen" : "gelezen"} | ${m.snippet}`)
    .join("\n");

  const messages = [
    {
      role: "user",
      content: `${mails.length > recentMails.length ? `(Dit zijn de ${CHAT_CONTEXT_LIMIT} recentste van in totaal ${mails.length} geladen mails — gebruik "zoek_mailbox" om verder terug te zoeken.)\n` : ""}Recente mails:\n${mailContext || "(geen mails gevonden)"}\n\nVraag van de dakwerker: ${message}`,
    },
  ];

  const MAX_TOOL_ROUNDS = 3;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let resp;
    try {
      resp = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: CHAT_SYSTEM,
        tools: [SEARCH_TOOL],
        messages,
      });
    } catch (e) {
      return "Er ging iets mis bij het antwoorden: " + e.message;
    }

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (!toolUses.length || round === MAX_TOOL_ROUNDS) {
      const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      return text || "Geen antwoord ontvangen.";
    }

    messages.push({ role: "assistant", content: resp.content });
    const toolResults = [];
    for (const use of toolUses) {
      const resultText = await runMailboxSearch(use.input?.zoekterm || "");
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: resultText });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return "Geen antwoord ontvangen.";
}

module.exports = { classifyMails, suggestReply, rewriteProfessional, chat, isConfigured, extractAfspraak };
