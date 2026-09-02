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
    anthropicApiKey: stored.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    aiToon: stored.aiToon || process.env.AI_TOON || "Vlaams, kort en professioneel",
    aiHandtekening: stored.aiHandtekening || process.env.AI_HANDTEKENING || "",
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

function removeAccount(index) {
  const stored = normaliseer(readStoredSettings());
  const i = Number(index);
  if (stored.accounts.length <= 1) throw new Error("De laatste mailbox kan je niet verwijderen.");
  if (!Number.isInteger(i) || i < 0 || i >= stored.accounts.length) {
    throw new Error("Die mailbox bestaat niet.");
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
    aiToon: config.aiToon,
    aiHandtekening: config.aiHandtekening,
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
  const geheim = (veld) => {
    // Een leeg wachtwoordveld betekent "niet wijzigen" — zo hoef je een
    // bestaand wachtwoord niet opnieuw te typen bij elke aanpassing.
    if (typeof update[veld] === "string" && update[veld].length > 0) acc[veld] = update[veld];
  };

  tekst("naam");
  tekst("displayName");
  tekst("imapHost");
  tekst("imapPort");
  tekst("imapUser");
  geheim("imapPassword");
  tekst("smtpHost");
  tekst("smtpPort");
  tekst("smtpUser");
  geheim("smtpPassword");
  // Handtekening mag meerdere regels bevatten — enkel spaties/lege regels aan
  // het einde weghalen, de opmaak binnenin blijft zoals de gebruiker ze typte.
  if (typeof update.handtekening === "string") acc.handtekening = update.handtekening.replace(/\s+$/, "");

  stored.accounts[i] = acc;

  // Gedeeld over alle mailboxen:
  if (typeof update.anthropicApiKey === "string" && update.anthropicApiKey.length > 0) {
    stored.anthropicApiKey = update.anthropicApiKey;
  }
  if (typeof update.aiToon === "string") stored.aiToon = update.aiToon.trim();
  if (typeof update.aiHandtekening === "string") stored.aiHandtekening = update.aiHandtekening.trim();

  writeStoredSettings(stored);
  return getPublicConfig();
}

module.exports = {
  getConfig,
  getPublicConfig,
  updateSettings,
  getAccounts,
  getActiveIndex,
  setActiveIndex,
  addAccount,
  removeAccount,
};
