// mailbox.js — praat met de IMAP-mailbox en houdt een korte cache bij.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const settings = require("./settings");

// Veiligheidslimiet: hoeveel mails we maximaal in één keer ophalen, om een
// (zeer) grote mailbox niet te laten vastlopen op een trage/timeoutende aanvraag.
// Binnen die grens wordt ECHT DE VOLLEDIGE mailbox getoond — dit is enkel een
// bovengrens voor een mailbox die groter is dan dat aantal berichten.
const ENVELOPE_CAP = 1500;

function isConfigured() {
  const c = settings.getConfig();
  return !!(c.imapHost && c.imapUser && c.imapPassword);
}

function client() {
  const c = settings.getConfig();
  return new ImapFlow({
    host: c.imapHost,
    port: Number(c.imapPort || 993),
    secure: true,
    auth: {
      user: c.imapUser,
      pass: c.imapPassword,
    },
    logger: false,
  });
}

// Zet HTML om naar leesbare platte tekst — vangnet voor mails die geen
// text/plain-versie hebben (enkel HTML), zodat die toch geopend kunnen worden.
function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, "\n\n")
    .trim();
}

async function extractPlainText(source) {
  try {
    const parsed = await simpleParser(source);
    if (parsed.text && parsed.text.trim()) return parsed.text.trim();
    if (parsed.html) return htmlToText(parsed.html);
    return "";
  } catch (e) {
    return "";
  }
}

// Haalt de volledige inbox op (tot ENVELOPE_CAP als veiligheidsgrens) zodat
// ELKE mail zichtbaar en te openen is — niet enkel de laatste 25. Dit is een
// lichte fetch (enkel envelope + vlaggen, geen inhoud) zodat dit snel blijft
// ook bij honderden/duizenden berichten. De inhoud (voor AI-beoordeling)
// wordt apart en in porties opgehaald via fetchSnippetsForUids — zie server.js.
async function fetchAllMails() {
  if (!isConfigured()) {
    return { configured: false, mails: [], total: 0, capped: false };
  }

  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const status = await imap.status("INBOX", { messages: true });
      const total = status.messages || 0;
      if (total === 0) return { configured: true, mails: [], total: 0, capped: false };

      const capped = total > ENVELOPE_CAP;
      const from = capped ? total - ENVELOPE_CAP + 1 : 1;

      const mails = [];
      for await (const msg of imap.fetch(`${from}:${total}`, { envelope: true, flags: true })) {
        mails.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
          fromAddress: msg.envelope.from?.[0]?.address || "",
          subject: msg.envelope.subject || "(geen onderwerp)",
          date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
          unread: !msg.flags.has("\\Seen"),
        });
      }
      mails.sort((a, b) => new Date(b.date) - new Date(a.date));

      return { configured: true, mails, total, capped };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Haalt voor een specifieke reeks uid's de inhoud op en bouwt er een kort
// fragment van (voor AI-beoordeling en als voorbeeldtekst in de inboxlijst).
async function fetchSnippetsForUids(uids) {
  const out = new Map();
  if (!isConfigured() || !uids || !uids.length) return out;
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      for await (const msg of imap.fetch(uids, { source: true }, { uid: true })) {
        const text = await extractPlainText(msg.source);
        out.set(msg.uid, text.replace(/\s+/g, " ").trim().slice(0, 300));
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return out;
}

async function fetchMailBody(uid) {
  if (!isConfigured()) {
    throw new Error("De mailbox is nog niet gekoppeld.");
  }
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const msg = await imap.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      if (!msg) return null;
      const text = await extractPlainText(msg.source);
      return {
        uid,
        from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
        fromAddress: msg.envelope.from?.[0]?.address || "",
        subject: msg.envelope.subject || "(geen onderwerp)",
        date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
        text,
      };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

async function parseAndBuild(msg) {
  let snippet = "";
  try {
    const text = await extractPlainText(msg.source);
    snippet = text.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch (e) {
    snippet = "";
  }
  return {
    uid: msg.uid,
    from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
    fromAddress: msg.envelope.from?.[0]?.address || "",
    subject: msg.envelope.subject || "(geen onderwerp)",
    date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
    unread: !msg.flags.has("\\Seen"),
    snippet,
  };
}

async function searchMails(query, limit = 30) {
  if (!isConfigured()) return { configured: false, mails: [] };
  const q = (query || "").trim();
  if (!q) return { configured: true, mails: [] };
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const uids = await imap.search({ text: q }, { uid: true });
      if (!uids || !uids.length) return { configured: true, mails: [] };
      const recentUids = uids.slice(-limit);
      const mails = [];
      for await (const msg of imap.fetch(recentUids, { envelope: true, flags: true, source: true }, { uid: true })) {
        mails.push(await parseAndBuild(msg));
      }
      mails.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { configured: true, mails };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

async function fetchMailsFromAddress(address, limit = 30) {
  if (!isConfigured()) return { configured: false, mails: [] };
  if (!address) return { configured: true, mails: [] };
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const uids = await imap.search({ from: address }, { uid: true });
      if (!uids || !uids.length) return { configured: true, mails: [] };
      const recentUids = uids.slice(-limit);
      const mails = [];
      for await (const msg of imap.fetch(recentUids, { envelope: true, flags: true, source: true }, { uid: true })) {
        mails.push(await parseAndBuild(msg));
      }
      mails.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { configured: true, mails };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

const SENT_FOLDER_CANDIDATES = [
  "sent", "sent items", "sent messages", "inbox.sent", "inbox/sent",
  "verzonden", "verzonden items", "verzonden berichten", "inbox.verzonden", "inbox/verzonden",
  "[gmail]/verzonden berichten", "[gmail]/sent mail",
];

async function findSentFolderPath(imap) {
  const list = await imap.list();
  const bySpecialUse = list.find((f) => f.specialUse === "\\Sent");
  if (bySpecialUse) return bySpecialUse.path;
  const byName = list.find((f) =>
    SENT_FOLDER_CANDIDATES.includes((f.path || "").toLowerCase()) ||
    SENT_FOLDER_CANDIDATES.includes((f.name || "").toLowerCase())
  );
  return byName ? byName.path : null;
}

const FOLLOWUP_MAX = 15;
const FOLLOWUP_DAYS = 30;

async function fetchFollowUps() {
  if (!isConfigured()) return { configured: false, supported: false, items: [] };
  const imap = client();
  await imap.connect();
  try {
    let sentPath;
    try {
      sentPath = await findSentFolderPath(imap);
    } catch (e) {
      return { configured: true, supported: false, items: [] };
    }
    if (!sentPath) return { configured: true, supported: false, items: [] };

    const since = new Date(Date.now() - FOLLOWUP_DAYS * 86400000);
    let sentMsgs = [];
    const sentLock = await imap.getMailboxLock(sentPath);
    try {
      const status = await imap.status(sentPath, { messages: true });
      const total = status.messages || 0;
      if (total > 0) {
        const from = Math.max(1, total - 60 + 1);
        for await (const msg of imap.fetch(`${from}:${total}`, { envelope: true })) {
          const to = msg.envelope.to?.[0];
          if (!to?.address) continue;
          const date = msg.envelope.date ? new Date(msg.envelope.date) : null;
          if (!date || date < since) continue;
          sentMsgs.push({ to: to.name || to.address, toAddress: to.address, subject: msg.envelope.subject || "(geen onderwerp)", date: date.toISOString() });
        }
      }
    } finally {
      sentLock.release();
    }

    sentMsgs.sort((a, b) => new Date(b.date) - new Date(a.date));
    const seen = new Set();
    const latestPerRecipient = [];
    for (const m of sentMsgs) {
      if (seen.has(m.toAddress)) continue;
      seen.add(m.toAddress);
      latestPerRecipient.push(m);
      if (latestPerRecipient.length >= FOLLOWUP_MAX) break;
    }

    const items = [];
    if (latestPerRecipient.length) {
      const inboxLock = await imap.getMailboxLock("INBOX");
      try {
        for (const m of latestPerRecipient) {
          try {
            const uids = await imap.search({ from: m.toAddress, since: new Date(m.date) }, { uid: true });
            m.replied = Array.isArray(uids) && uids.length > 0;
          } catch (e) {
            m.replied = true; // bij twijfel niet tonen als opvolging
          }
        }
      } finally {
        inboxLock.release();
      }
    }
    for (const m of latestPerRecipient) {
      if (!m.replied) items.push(m);
    }
    return { configured: true, supported: true, items };
  } finally {
    await imap.logout().catch(() => {});
  }
}

module.exports = {
  fetchAllMails,
  fetchSnippetsForUids,
  fetchMailBody,
  searchMails,
  fetchMailsFromAddress,
  fetchFollowUps,
  isConfigured,
  ENVELOPE_CAP,
};
