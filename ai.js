// ai.js — praat met de Claude API voor classificatie en de chat.
const Anthropic = require("@anthropic-ai/sdk");
const settings = require("./settings");

function isConfigured() {
  return !!settings.getConfig().anthropicApiKey;
}

function client() {
    return new Anthropic({ apiKey: settings.getConfig().anthropicApiKey });
}

const CLASSIFY_SYSTEM = `Je bent de AI-assistent van Mailvio, een persoonlijke mailapp voor een zelfstandige dakwerker in Vlaanderen.
Je krijgt een lijst van recente mails. Beoordeel per mail hoe dringend die is voor de dakwerker, puur op basis van de inhoud (niet op basis van gelezen/ongelezen).

Gebruik exact een van deze categorieën:
- "dringend": vraagt vandaag nog een reactie (bv. een klacht, een klant die dringend iets nodig heeft)
- "vandaag": zou vandaag beantwoord moeten worden (bv. een offertevraag, een planningsvraag)
- "binnenkort": kan nog een paar dagen wachten (bv. een leverancier zonder directe vraag)
- "geen_actie": geen antwoord nodig (bv. reclame, nieuwsbrief, bevestiging, bedankmail)

Antwoord ALLEEN met geldige JSON, een array van objecten: [{"uid": <uid>, "categorie": "...", "reden": "korte reden in het Vlaams, max 12 woorden"}]. Geen andere tekst.`;

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
  max_tokens: 1024,
  system: CLASSIFY_SYSTEM,
  messages: [{ role: "user", content: JSON.stringify(input) }],
});

const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    const match = text.match(/\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : text);
  } catch (e) {
    return [];
  }
}

const CHAT_SYSTEM = `Je bent de AI-assistent in Mailvio, een persoonlijke mailapp voor een zelfstandige dakwerker in Vlaanderen.
Je krijgt de recente mails uit zijn mailbox als context. Beantwoord zijn vraag kort, direct en vriendelijk in het Vlaams — geen lange uitleg, geen jargon.
Als je een mail voorstelt te herschrijven of te beantwoorden, schrijf die dan meteen kort en professioneel uit.`;

async function chat(message, mails) {
  if (!isConfigured()) {
    return "De AI is nog niet ingesteld — er ontbreekt een ANTHROPIC_API_KEY. Voeg die toe bij de instellingen van de service.";
  }
  const anthropic = client();
  const mailContext = mails
  .map((m) => `- (${m.uid}) Van: ${m.from} | Onderwerp: ${m.subject} | ${m.unread ? "ongelezen" : "gelezen"} | ${m.snippet}`)
  .join("\n");

const resp = await anthropic.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 1024,
  system: CHAT_SYSTEM,
  messages: [
    {
      role: "user",
      content: `Recente mails:\n${mailContext || "(geen mails gevonden)"}\n\nVraag van de dakwerker: ${message}`,
    },
    ],
});

return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

module.exports = { classifyMails, chat, isConfigured };
