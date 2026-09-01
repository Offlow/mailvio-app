require("dotenv").config();
const express = require("express");
const path = require("path");
const mailbox = require("./mailbox");
const ai = require("./ai");
const settingsStore = require("./settings");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuten - houdt AI-kosten laag
let cache = { at: 0, mails: [] };

async function getMails(forceRefresh) {
const fresh = !forceRefresh && Date.now() - cache.at < CACHE_TTL_MS && cache.mails.length > 0;
if (fresh) return cache.mails;

const { configured, mails } = await mailbox.fetchRecentMails();
if (!configured) {
cache = { at: Date.now(), mails: [] };
return [];
}

let classifications = [];
try {
classifications = await ai.classifyMails(mails);
} catch (e) {
console.error("Classificatie mislukt:", e.message);
}
const byUid = Object.fromEntries(classifications.map((c) => [c.uid, c]));

const merged = mails.map((m) => ({
...m,
categorie: byUid[m.uid]?.categorie || "onbekend",
reden: byUid[m.uid]?.reden || "",
}));

cache = { at: Date.now(), mails: merged };
return merged;
}

app.get("/api/status", (req, res) => {
res.json({
imapConfigured: mailbox.isConfigured(),
aiConfigured: ai.isConfigured(),
});
});

app.get("/api/settings", (req, res) => {
  res.json(settingsStore.getPublicConfig());
});

app.post("/api/settings", (req, res) => {
  try {
    const updated = settingsStore.updateSettings(req.body || {});
    cache = { at: 0, mails: [] };
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kon de instellingen niet opslaan.", detail: e.message });
  }
});

app.get("/api/mails", async (req, res) => {
try {
const mails = await getMails(req.query.refresh === "1");
res.json({
imapConfigured: mailbox.isConfigured(),
aiConfigured: ai.isConfigured(),
mails,
});
} catch (e) {
console.error(e);
res.status(500).json({ error: "Kon de mailbox niet ophalen.", detail: e.message });
}
});

app.post("/api/chat", async (req, res) => {
const { message } = req.body || {};
if (!message || typeof message !== "string") {
return res.status(400).json({ error: "Geen vraag meegegeven." });
}
try {
const mails = await getMails(false);
const answer = await ai.chat(message, mails);
res.json({ answer });
} catch (e) {
console.error(e);
res.status(500).json({ error: "De AI kon niet antwoorden.", detail: e.message });
}
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log(`Mailvio draait op poort ${PORT}`);
});
