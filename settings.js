// settings.js — houdt de IMAP- en AI-instellingen bij die via de app zelf zijn ingesteld.
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
imapHost: stored.imapHost || process.env.IMAP_HOST || "",
imapPort: stored.imapPort || process.env.IMAP_PORT || "993",
imapUser: stored.imapUser || process.env.IMAP_USER || "",
imapPassword: stored.imapPassword || process.env.IMAP_PASSWORD || "",
anthropicApiKey: stored.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
};
}

function getPublicConfig() {
const config = getConfig();
return {
imapHost: config.imapHost,
imapPort: config.imapPort,
imapUser: config.imapUser,
hasImapPassword: !!config.imapPassword,
hasApiKey: !!config.anthropicApiKey,
};
}

function updateSettings(update) {
const stored = readStoredSettings();
const next = { ...stored };

if (typeof update.imapHost === "string") next.imapHost = update.imapHost.trim();
if (typeof update.imapPort === "string") next.imapPort = update.imapPort.trim();
if (typeof update.imapUser === "string") next.imapUser = update.imapUser.trim();
if (typeof update.imapPassword === "string" && update.imapPassword.length > 0) {
next.imapPassword = update.imapPassword;
}
if (typeof update.anthropicApiKey === "string" && update.anthropicApiKey.length > 0) {
next.anthropicApiKey = update.anthropicApiKey;
}

writeStoredSettings(next);
return getPublicConfig();
}

module.exports = { getConfig, getPublicConfig, updateSettings };

module.exports = { getConfig, getPublicConfig, updateSettings };
