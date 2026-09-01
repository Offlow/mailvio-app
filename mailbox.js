// mailbox.js — praat met de IMAP-mailbox en houdt een korte cache bij.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const settings = require("./settings");

const MAX_MESSAGES = 25;

function isConfigured() {
  const c = settings.getConfig();
    return !!(c.imapHost && c.imapUser && c.imapPassword);
}

async function fetchRecentMails() {
if (!isConfigured()) {
return { configured: false, mails: [] };
}

  const c = settings.getConfig();
  const client = new ImapFlow({
    host: c.imapHost,
    port: Number(c.imapPort || 993),
secure: true,
auth: {
      user: c.imapUser,
      pass: c.imapPassword,
},
logger: false,
});

const mails = [];

await client.connect();
try {
const lock = await client.getMailboxLock("INBOX");
try {
const status = await client.status("INBOX", { messages: true });
const total = status.messages || 0;
const from = Math.max(1, total - MAX_MESSAGES + 1);
if (total > 0) {
for await (const msg of client.fetch(`${from}:${total}`, {
envelope: true,
flags: true,
source: true,
})) {
let snippet = "";
try {
const parsed = await simpleParser(msg.source);
snippet = (parsed.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
} catch (e) {
snippet = "";
}
mails.push({
uid: msg.uid,
from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
fromAddress: msg.envelope.from?.[0]?.address || "",
subject: msg.envelope.subject || "(geen onderwerp)",
date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
unread: !msg.flags.has("\\Seen"),
snippet,
});
}
}
} finally {
lock.release();
}
} finally {
await client.logout().catch(() => {});
}

mails.sort((a, b) => new Date(b.date) - new Date(a.date));
return { configured: true, mails };
}

module.exports = { fetchRecentMails, isConfigured, MAX_MESSAGES };
