// settings.js — houdt de IMAP-, SMTP- en AI-instellingen bij die via de app zelf zijn ingesteld.
// Vult aan met omgevingsvariabelen (Render "Environment") als er niets is opgeslagen.
const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "data", "settings.json");

function readStoredSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function writeStoredSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}

function getConfig() {
  const stored = readStoredSettings();
  return {
    displayName: stored.displayName || process.env.MAIL_DISPLAY_NAME || "",
    imapHost: stored.imapHost || process.env.IMAP_HOST || "",
    imapPort: stored.imapPort || process.env.IMAP_PORT || "993",
    imapUser: stored.imapUser || process.env.IMAP_USER || "",
    imapPassword: stored.imapPassword || process.env.IMAP_PASSWORD || "",
    smtpHost: stored.smtpHost || process.env.SMTP_HOST || "",
    smtpPort: stored.smtpPort || process.env.SMTP_PORT || "587",
    smtpUser: stored.smtpUser || process.env.SMTP_USER || "",
    smtpPassword: stored.smtpPassword || process.env.SMTP_PASSWORD || "",
    anthropicApiKey: stored.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    aiToon: stored.aiToon || process.env.AI_TOON || "Vlaams, kort en professioneel",
    aiHandtekening: stored.aiHandtekening || process.env.AI_HANDTEKENING || "",
  };
}

function getPublicConfig() {
  const config = getConfig();
  return {
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
  };
}

function updateSettings(update) {
  const stored = readStoredSettings();
  const next = { ...stored };

  if (typeof update.displayName === "string") next.displayName = update.displayName.trim();
  if (typeof update.imapHost === "string") next.imapHost = update.imapHost.trim();
  if (typeof update.imapPort === "string") next.imapPort = update.imapPort.trim();
  if (typeof update.imapUser === "string") next.imapUser = update.imapUser.trim();
  if (typeof update.imapPassword === "string" && update.imapPassword.length > 0) {
    next.imapPassword = update.imapPassword;
  }
  if (typeof update.smtpHost === "string") next.smtpHost = update.smtpHost.trim();
  if (typeof update.smtpPort === "string") next.smtpPort = update.smtpPort.trim();
  if (typeof update.smtpUser === "string") next.smtpUser = update.smtpUser.trim();
  if (typeof update.smtpPassword === "string" && update.smtpPassword.length > 0) {
    next.smtpPassword = update.smtpPassword;
  }
  if (typeof update.anthropicApiKey === "string" && update.anthropicApiKey.length > 0) {
    next.anthropicApiKey = update.anthropicApiKey;
  }
  if (typeof update.aiToon === "string") next.aiToon = update.aiToon.trim();
  if (typeof update.aiHandtekening === "string") next.aiHandtekening = update.aiHandtekening.trim();

  writeStoredSettings(next);
  return getPublicConfig();
}

module.exports = { getConfig, getPublicConfig, updateSettings };
