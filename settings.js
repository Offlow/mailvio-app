// settings.js — houdt de mailaccounts en AI-instellingen bij die via de app
// zelf zijn ingesteld. Vult aan met omgevingsvariabelen als er niets is
// opgeslagen.
//
// Mailvio ondersteunt MEERDERE mailboxen (bv. info@daklo.be en
// boekhouding@daklo.be). Op schijf ziet dat er zo uit:
//
//   { actief: 0,
//     accounts: [ { naam, displayName, imapHost, ... }, { ... } ],
//     aiToon, aiHandtekening, anthropicApiKey }
//
// De AI-sleutel en schrijfstijl zijn gedeeld; alle mailgegevens horen bij een
// account. Oudere installaties hebben nog één platte set velden — die worden
// bij het eerste gebruik automatisch omgezet naar accounts[0], zodat er niets
// verloren gaat.
const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "data", "settings.json");

const ACCOUNT_VELDEN = [
  "naam",
  "displayName",
  "imapHost",
  "imapPort",
  "imapUser",
  "imapPassword",
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpPassword",
  "handtekening",
];

function readStoredSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function writeStoredSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}

// Zet een oude, platte opslag om naar de accountstructuur — zonder iets weg
// te gooien. Wordt ook gebruikt als er nog niets is ingesteld.
function normaliseer(stored) {
  if (Array.isArray(stored.accounts) && stored.accounts.length) {
    return {
      ...stored,
      accounts: stored.accounts,
      actief: Math.min(Math.max(Number(stored.actief) || 0, 0), stored.accounts.length - 1),
    };
  }
  const eerste = {};
  for (const v of ACCOUNT_VELDEN) if (stored[v] !== undefined) eerste[v] = stored[v];
  return {
    ...stored,
    accounts: [eerste],
    actief: 0,
  };
}

function omgevingAccount() {
  return {
    naam: "",
    displayName: process.env.MAIL_DISPLAY_NAME || "",
    imapHost: process.env.IMAP_HOST || "",
    imapPort: process.env.IMAP_PORT || "993",
    imapUser: process.env.IMAP_USER || "",
    imapPassword: process.env.IMAP_PASSWORD || "",
    smtpHost: process.env.SMTP_HOST || "",
    smtpPort: process.env.SMTP_PORT || "587",
    smtpUser: process.env.SMTP_USER || "",
    smtpPassword: process.env.SMTP_PASSWORD || "",
    handtekening: process.env.MAIL_HANDTEKENING || "",
  };
}

function accountConfig(account) {
  const env = omgevingAccount();
  const a = account || {};
  return {
    naam: a.naam || "",
    displayName: a.displayName || env.displayName,
    imapHost: a.imapHost || env.imapHost,
    imapPort: a.imapPort || env.imapPort,
    imapUser: a.imapUser || env.imapUser,
    imapPassword: a.imapPassword || env.imapPassword,
    smtpHost: a.smtpHost || env.smtpHost,
    smtpPort: a.smtpPort || env.smtpPort,
    smtpUser: a.smtpUser || env.smtpUser,
    smtpPassword: a.smtpPassword || env.smtpPassword,
    handtekening: a.handtekening || env.handtekening,
  };
}

// De instellingen van de mailbox waar je nu in werkt. Alle bestaande code
// (mailbox.js, mailer.js, ai.js) blijft hier gewoon op werken.
function getConfig() {
  const stored = normaliseer(readStoredSettings());
  const actief = stored.accounts[stored.actief] || stored.accounts[0] || {};
  return {
    ...accountConfig(actief),
    anthropicApiKey: String(stored.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "").trim(),
    aiToon: stored.aiToon || process.env.AI_TOON || "Vlaams, kort en professioneel",
    aiHandtekening: stored.aiHandtekening || process.env.AI_HANDTEKENING || "",
    // Reclame en nieuwsbrieven zien er pas uit zoals ze bedoeld zijn als de
    // afbeeldingen mee geladen worden. Standaard uit (dan weet een afzender
    // niet dat je zijn mail geopend hebt), maar je kan het aanzetten.
    // AFBEELDINGEN STAAN STANDAARD AAN.
    // Logo's en beelden horen bij een mail; zonder die beelden is een
    // nieuwsbrief of een offerte met foto's niet te lezen. Wie liever niet
    // heeft dat een afzender ziet dat de mail geopend is, kan dit uitzetten
    // bij Instellingen.
    toonAfbeeldingen: stored.toonAfbeeldingen !== false,
    // ÉÉN INBOX VOOR AL JE MAILBOXEN.
    // Je hebt twee mailboxen maar één hoofd. Staat dit aan, dan komt de post van
    // allebei in dezelfde lijst te staan, met bij elke mail een label van welke
    // mailbox ze komt. Standaard aan; je kan het uitzetten als je ze liever
    // apart houdt.
    samenvoegen: stored.samenvoegen !== false,
    // Hoe Mailvio JOU aanspreekt. Los van de mailboxnaam: die kan
    // "info@daklo.be" of "boekhouding" zijn, maar jij blijft dezelfde persoon.
    aanspreektitel: stored.aanspreektitel || "",
    // Welk AI-model waarvoor. Beoordelen is simpel werk dat heel vaak gebeurt —
    // daar past een klein, snel en goedkoop model bij. Antwoorden schrijven en
    // vragen beantwoorden vraagt meer, dus daar staat standaard een sterker
    // model. Je kan beide zelf kiezen.
    // Sommige Anthropic-sleutels (identity-linked keys) werken enkel als je er
    // ook het workspace-id bij stuurt. Zonder dat geeft élke AI-oproep een
    // 400-fout en blijft je mailbox "dom".
    anthropicWorkspaceId: stored.anthropicWorkspaceId || process.env.ANTHROPIC_WORKSPACE_ID || "",
    aiModelSnel: stored.aiModelSnel || process.env.AI_MODEL_SNEL || "claude-haiku-4-5",
    aiModelSlim: stored.aiModelSlim || process.env.AI_MODEL_SLIM || "claude-sonnet-5",
  };
}

// Naam waaronder een account in de zijbalk staat.
function accountLabel(config, index) {
  return config.naam || config.imapUser || `Mailbox ${index + 1}`;
}

function getAccounts() {
  const stored = normaliseer(readStoredSettings());
  return stored.accounts.map((a, i) => {
    const c = accountConfig(a);
    return {
      index: i,
      label: accountLabel(c, i),
      imapUser: c.imapUser,
      ingesteld: !!(c.imapHost && c.imapUser && c.imapPassword),
      actief: i === stored.actief,
    };
  });
}

// De volledige (interne) instellingen van ELK account — nodig om over alle
// mailboxen heen te kunnen zoeken, ook al werk je nu in maar één ervan.
function getAlleConfigs() {
  const stored = normaliseer(readStoredSettings());
  return stored.accounts
    .map((a, i) => ({ index: i, label: accountLabel(accountConfig(a), i), ...accountConfig(a) }))
    .filter((c) => c.imapHost && c.imapUser && c.imapPassword);
}

function getActiveIndex() {
  return normaliseer(readStoredSettings()).actief;
}

function setActiveIndex(index) {
  const stored = normaliseer(readStoredSettings());
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= stored.accounts.length) {
    throw new Error("Die mailbox bestaat niet.");
  }
  stored.actief = i;
  writeStoredSettings(stored);
  return getActiveIndex();
}

function addAccount() {
  const stored = normaliseer(readStoredSettings());
  stored.accounts.push({});
  stored.actief = stored.accounts.length - 1;
  writeStoredSettings(stored);
  return stored.actief;
}

// EEN INGESTELDE MAILBOX KAN NIET VERWIJDERD WORDEN.
// Je mailboxen mogen nooit verdwijnen — niet door een misklik, niet door een
// fout hier. Enkel een leeg, nog niet ingevuld vakje mag weg. Wil je er toch
// eentje kwijt, dan maak je eerst zelf de gegevens leeg; dan pas kan het.
function removeAccount(index) {
  const stored = normaliseer(readStoredSettings());
  const i = Number(index);
  if (stored.accounts.length <= 1) throw new Error("De laatste mailbox kan je niet verwijderen.");
  if (!Number.isInteger(i) || i < 0 || i >= stored.accounts.length) {
    throw new Error("Die mailbox bestaat niet.");
  }
  const c = accountConfig(stored.accounts[i]);
  if (c.imapHost && c.imapUser && c.imapPassword) {
    throw new Error(`"${accountLabel(c, i)}" is ingesteld en kan niet verwijderd worden. Maak eerst de gegevens leeg als je ze echt kwijt wil.`);
  }
  stored.accounts.splice(i, 1);
  stored.actief = Math.min(stored.actief, stored.accounts.length - 1);
  writeStoredSettings(stored);
  return getAccounts();
}

function getPublicConfig() {
  const config = getConfig();
  return {
    naam: config.naam,
    displayName: config.displayName,
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    imapUser: config.imapUser,
    hasImapPassword: !!config.imapPassword,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpUser: config.smtpUser,
    hasSmtpPassword: !!config.smtpPassword,
    hasApiKey: !!config.anthropicApiKey,
    // Genoeg om te herkennen WELKE sleutel er staat, te weinig om ermee te doen.
    apiKeyHint: config.anthropicApiKey
      ? `${config.anthropicApiKey.slice(0, 11)}...${config.anthropicApiKey.slice(-4)} (${config.anthropicApiKey.length} tekens)`
      : "",
    aiToon: config.aiToon,
    aiHandtekening: config.aiHandtekening,
    toonAfbeeldingen: config.toonAfbeeldingen,
    samenvoegen: config.samenvoegen,
    aanspreektitel: config.aanspreektitel,
    heeftWorkspaceId: !!config.anthropicWorkspaceId,
    anthropicWorkspaceId: config.anthropicWorkspaceId,
    aiModelSnel: config.aiModelSnel,
    aiModelSlim: config.aiModelSlim,
    handtekening: config.handtekening,
    accounts: getAccounts(),
    actief: getActiveIndex(),
  };
}

// Werkt de instellingen bij. Zonder "account" in de update gaat het over de
// mailbox waar je nu in werkt.
function updateSettings(update) {
  const stored = normaliseer(readStoredSettings());
  const i = update.account !== undefined ? Number(update.account) : stored.actief;
  if (!Number.isInteger(i) || i < 0 || i >= stored.accounts.length) {
    throw new Error("Die mailbox bestaat niet.");
  }
  const acc = { ...(stored.accounts[i] || {}) };

  const tekst = (veld) => {
    if (typeof update[veld] === "string") acc[veld] = update[veld].trim();
  };
  // DE KERN VAN EEN MAILBOX KAN NIET LEEGGEMAAKT WORDEN.
  // Het adres en de server zijn wat een mailbox ÍS. Kwam er ooit een lege
  // waarde binnen — een formulier dat nog niet ingevuld was, een oproep die
  // maar één veld meestuurde — dan was je mailbox in één klap weg. Een leeg
  // veld betekent nu "niet wijzigen", net zoals bij een wachtwoord.
  const kern = (veld) => {
    if (typeof update[veld] === "string" && update[veld].trim().length > 0) acc[veld] = update[veld].trim();
  };
  const geheim = (veld) => {
    // Een leeg wachtwoordveld betekent "niet wijzigen" — zo hoef je een
    // bestaand wachtwoord niet opnieuw te typen bij elke aanpassing.
    if (typeof update[veld] === "string" && update[veld].length > 0) acc[veld] = update[veld];
  };

  tekst("naam");
  tekst("displayName");
  kern("imapHost");
  tekst("imapPort");
  kern("imapUser");
  geheim("imapPassword");
  kern("smtpHost");
  tekst("smtpPort");
  kern("smtpUser");
  geheim("smtpPassword");
  // Handtekening mag meerdere regels bevatten — enkel spaties/lege regels aan
  // het einde weghalen, de opmaak binnenin blijft zoals de gebruiker ze typte.
  if (typeof update.handtekening === "string") acc.handtekening = update.handtekening.replace(/\s+$/, "");

  stored.accounts[i] = acc;

  // Gedeeld over alle mailboxen:
  if (typeof update.anthropicApiKey === "string" && update.anthropicApiKey.trim().length > 0) {
    // Bij het plakken komt er vaak een spatie, een regeleinde of een onzichtbaar
    // teken mee. De API weigert de sleutel dan met "API key is invalid", terwijl
    // hij er in het veld perfect uitziet. Daarom hier alles wegpoetsen.
    stored.anthropicApiKey = update.anthropicApiKey.replace(/[\s\u200b-\u200d\ufeff]/g, "");
  }
  if (typeof update.aiToon === "string") stored.aiToon = update.aiToon.trim();
  if (typeof update.aiHandtekening === "string") stored.aiHandtekening = update.aiHandtekening.trim();
  if (typeof update.toonAfbeeldingen === "boolean") stored.toonAfbeeldingen = update.toonAfbeeldingen;
  if (typeof update.samenvoegen === "boolean") stored.samenvoegen = update.samenvoegen;
  if (typeof update.aanspreektitel === "string") stored.aanspreektitel = update.aanspreektitel.trim();
  if (typeof update.anthropicWorkspaceId === "string") stored.anthropicWorkspaceId = update.anthropicWorkspaceId.replace(/[\s\u200b-\u200d\ufeff]/g, "");
  if (typeof update.aiModelSnel === "string" && update.aiModelSnel.trim()) stored.aiModelSnel = update.aiModelSnel.trim();
  if (typeof update.aiModelSlim === "string" && update.aiModelSlim.trim()) stored.aiModelSlim = update.aiModelSlim.trim();

  writeStoredSettings(stored);
  return getPublicConfig();
}

module.exports = {
  getConfig,
  getAlleConfigs,
  getPublicConfig,
  updateSettings,
  getAccounts,
  getActiveIndex,
  setActiveIndex,
  addAccount,
  removeAccount,
};
