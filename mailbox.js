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

function client(config) {
  const c = config || settings.getConfig();
  const imap = new ImapFlow({
    host: c.imapHost,
    port: Number(c.imapPort || 993),
    secure: true,
    auth: {
      user: c.imapUser,
      pass: c.imapPassword,
    },
    logger: false,
  });
  // ZONDER DEZE REGEL VALT DE HELE APP OM.
  // imapflow stuurt een "error"-gebeurtenis als de mailserver de verbinding
  // laat vallen (time-out, reset, server die dichtklapt). Een error-gebeurtenis
  // zonder luisteraar is in Node een crash van het volledige proces — dan is
  // Mailvio plots onbereikbaar. We vangen ze op en loggen ze; de aanroeper
  // krijgt de fout gewoon via zijn eigen try/catch te zien.
  imap.on("error", (err) => {
    console.error("IMAP-verbindingsfout:", err && err.message ? err.message : err);
  });
  return imap;
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

// Maakt de HTML van een mail veilig om te tonen: alles wat code kan uitvoeren
// of stiekem gegevens kan versturen gaat eruit. Externe afbeeldingen worden
// onklaar gemaakt (src -> data-src) zodat een afzender niet kan zien dat je de
// mail geopend hebt; de app kan ze op vraag alsnog laden.
function schoonHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, "")
    // inline event-handlers (onclick, onerror, ...)
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    // javascript:-links
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    // externe afbeeldingen pas laden als de gebruiker het vraagt.
    // Ook srcset en background meepakken, anders laadt een nieuwsbrief zijn
    // beelden alsnog langs de achterdeur binnen.
    .replace(/<img([^>]*?)\ssrc\s*=/gi, "<img$1 data-src=")
    .replace(/<img([^>]*?)\ssrcset\s*=/gi, "<img$1 data-srcset=")
    .replace(/<(td|table|div|body)([^>]*?)\sbackground\s*=/gi, "<$1$2 data-background=");
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
// Kijkt in de structuur van een mail of er een echte bijlage in zit, zonder
// de mail zelf te downloaden.
function heeftBijlage(node) {
  if (!node) return false;
  const disp = (node.disposition || "").toLowerCase();
  if (disp === "attachment") return true;
  if (node.dispositionParameters?.filename || node.parameters?.name) {
    const type = (node.type || "").toLowerCase();
    if (!type.startsWith("text/") && !type.startsWith("multipart/")) return true;
  }
  return (node.childNodes || []).some(heeftBijlage);
}

// Haalt ENKEL op wat we nog niet hebben. Geeft terug welke uid's er nu op de
// server staan, zodat de opslag weet wat er ondertussen verdwenen is.
//
// sindsUid = het hoogste nummer dat we al kennen; alles daarboven is nieuw.
async function fetchNieuweMails(folder, sindsUid) {
  if (!isConfigured()) return { configured: false, nieuwe: [], alleUids: [], uidValidity: null };

  const box = folder || "INBOX";
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(box);
    try {
      const mailboxInfo = imap.mailbox || {};
      const uidValidity = mailboxInfo.uidValidity ? String(mailboxInfo.uidValidity) : null;

      // Welke berichten staan er nu op de server? (enkel nummers, heel licht)
      const alleUids = await imap.search({ all: true }, { uid: true });
      const bestaande = (alleUids || []).map(Number);

      const nieuweUids = bestaande.filter((u) => u > Number(sindsUid || 0));
      // Veiligheidsgrens blijft gelden voor een allereerste keer inladen.
      const teHalen = nieuweUids.slice(-ENVELOPE_CAP);

      const nieuwe = [];
      if (teHalen.length) {
        for await (const msg of imap.fetch(teHalen, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
          nieuwe.push({
            uid: msg.uid,
            from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
            fromAddress: msg.envelope.from?.[0]?.address || "",
            subject: msg.envelope.subject || "(geen onderwerp)",
            date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
            unread: !msg.flags.has("\\Seen"),
            heeftBijlage: heeftBijlage(msg.bodyStructure),
          });
        }
      }

      return { configured: true, nieuwe, alleUids: bestaande, uidValidity, capped: nieuweUids.length > ENVELOPE_CAP };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Haalt een portie OUDERE berichten op — die van vóór wat we al bewaard
// hebben. Zo vult een grote mailbox (duizenden mails) zichzelf stap voor stap
// aan op de achtergrond, zonder ooit één zware ophaalbeurt te doen.
async function fetchOudereMails(folder, onderUid, aantal) {
  if (!isConfigured() || !onderUid) return { configured: false, mails: [] };
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder || "INBOX");
    try {
      const alleUids = await imap.search({ all: true }, { uid: true });
      const ouder = (alleUids || []).map(Number).filter((u) => u < Number(onderUid));
      if (!ouder.length) return { configured: true, mails: [], klaar: true };
      const teHalen = ouder.slice(-Math.max(1, Number(aantal) || 200));

      const mails = [];
      for await (const msg of imap.fetch(teHalen, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
        mails.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
          fromAddress: msg.envelope.from?.[0]?.address || "",
          subject: msg.envelope.subject || "(geen onderwerp)",
          date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
          unread: !msg.flags.has("\\Seen"),
          heeftBijlage: heeftBijlage(msg.bodyStructure),
        });
      }
      return { configured: true, mails, klaar: ouder.length <= teHalen.length, resterend: ouder.length - teHalen.length };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Haalt enkel de gelezen/ongelezen-vlaggen op van de recentste berichten, zodat
// een mail die je elders (gsm, Outlook) las hier ook als gelezen komt te staan.
async function fetchVlaggen(folder, uids) {
  if (!isConfigured() || !uids || !uids.length) return new Map();
  const out = new Map();
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder || "INBOX");
    try {
      for await (const msg of imap.fetch(uids, { flags: true }, { uid: true })) {
        out.set(msg.uid, { unread: !msg.flags.has("\\Seen") });
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return out;
}

async function fetchAllMails(folder) {
  if (!isConfigured()) {
    return { configured: false, mails: [], total: 0, capped: false };
  }

  const box = folder || "INBOX";
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(box);
    try {
      const status = await imap.status(box, { messages: true });
      const total = status.messages || 0;
      if (total === 0) return { configured: true, mails: [], total: 0, capped: false };

      const capped = total > ENVELOPE_CAP;
      const from = capped ? total - ENVELOPE_CAP + 1 : 1;

      const mails = [];
      // bodyStructure erbij: daarmee weten we of er bijlagen zijn zonder de
      // volledige mail te downloaden (blijft dus snel).
      for await (const msg of imap.fetch(`${from}:${total}`, { envelope: true, flags: true, bodyStructure: true })) {
        mails.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
          fromAddress: msg.envelope.from?.[0]?.address || "",
          subject: msg.envelope.subject || "(geen onderwerp)",
          date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
          unread: !msg.flags.has("\\Seen"),
          heeftBijlage: heeftBijlage(msg.bodyStructure),
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
// Voor een fragment van 300 tekens hebben we niet de hele mail nodig. Vroeger
// werd elk bericht volledig ingelezen — inclusief bijlagen van megabytes —
// waardoor de server door zijn geheugen ging. Nu lezen we per mail hoogstens
// SNIPPET_MAX_BYTES aan begin van het bericht.
const SNIPPET_MAX_BYTES = 64 * 1024;

async function fetchSnippetsForUids(uids, folder) {
  const out = new Map();
  if (!isConfigured() || !uids || !uids.length) return out;
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder || "INBOX");
    try {
      for (const uid of uids) {
        let tekst = "";
        try {
          // download() met maxBytes stopt met lezen zodra we genoeg hebben.
          const dl = await imap.download(String(uid), undefined, { uid: true, maxBytes: SNIPPET_MAX_BYTES });
          if (dl && dl.content) {
            const stukken = [];
            let bytes = 0;
            for await (const chunk of dl.content) {
              stukken.push(chunk);
              bytes += chunk.length;
              if (bytes >= SNIPPET_MAX_BYTES) break;
            }
            tekst = await extractPlainText(Buffer.concat(stukken));
          }
        } catch (e) {
          tekst = "";
        }
        out.set(uid, tekst.replace(/\s+/g, " ").trim().slice(0, 300));
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
  return out;
}

async function fetchMailBody(uid, folder) {
  if (!isConfigured()) {
    throw new Error("De mailbox is nog niet gekoppeld.");
  }
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder || "INBOX");
    try {
      const msg = await imap.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      if (!msg) return null;
      const parsed = await simpleParser(msg.source).catch(() => null);
      const text = parsed
        ? (parsed.text && parsed.text.trim() ? parsed.text.trim() : htmlToText(parsed.html))
        : await extractPlainText(msg.source);
      // Bijlagen (offertes, facturen, foto's van een dak, ...) tonen we in de
      // mail zelf; de inhoud zelf wordt pas opgehaald als je ze opent.
      const html = parsed?.html ? schoonHtml(parsed.html) : "";
      const attachments = (parsed?.attachments || [])
        .filter((a) => a.contentDisposition !== "inline" || a.filename)
        .map((a, i) => ({
          index: i,
          filename: a.filename || `bijlage-${i + 1}`,
          contentType: a.contentType || "application/octet-stream",
          size: a.size || (a.content ? a.content.length : 0),
        }));
      const env = msg.envelope || {};
      const adressen = (lijst) =>
        (lijst || [])
          .map((a) => a.address)
          .filter(Boolean);
      return {
        uid,
        from: env.from?.[0]?.name || env.from?.[0]?.address || "Onbekend",
        fromAddress: env.from?.[0]?.address || "",
        // Voor "Allen beantwoorden": alle andere geadresseerden van de mail.
        to: adressen(env.to),
        cc: adressen(env.cc),
        // Voor een net antwoord in dezelfde conversatie (threading in Outlook/Gmail).
        messageId: env.messageId || "",
        replyTo: env.replyTo?.[0]?.address || "",
        subject: env.subject || "(geen onderwerp)",
        date: env.date ? new Date(env.date).toISOString() : null,
        text,
        html,
        attachments,
      };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Haalt één bijlage op zodat ze gedownload/geopend kan worden.
async function fetchAttachment(uid, index, folder) {
  if (!isConfigured()) throw new Error("De mailbox is nog niet gekoppeld.");
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder || "INBOX");
    try {
      const msg = await imap.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg) return null;
      const parsed = await simpleParser(msg.source);
      const lijst = (parsed.attachments || []).filter((a) => a.contentDisposition !== "inline" || a.filename);
      const att = lijst[Number(index)];
      if (!att) return null;
      return {
        filename: att.filename || `bijlage-${Number(index) + 1}`,
        contentType: att.contentType || "application/octet-stream",
        content: att.content,
      };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Haalt de echte mappenstructuur van de mailbox op (Inbox, Verzonden,
// Concepten, Archief, Prullenmand + eigen mappen), met het aantal berichten
// en het aantal ongelezen per map.
const ROL_PER_SPECIALUSE = {
  "\\Inbox": "inbox",
  "\\Sent": "verzonden",
  "\\Drafts": "concepten",
  "\\Trash": "prullenmand",
  "\\Junk": "spam",
  "\\Archive": "archief",
};

const ROL_PER_NAAM = {
  inbox: "inbox",
  sent: "verzonden",
  "sent items": "verzonden",
  "sent messages": "verzonden",
  verzonden: "verzonden",
  "verzonden items": "verzonden",
  drafts: "concepten",
  concepten: "concepten",
  trash: "prullenmand",
  deleted: "prullenmand",
  "deleted items": "prullenmand",
  prullenmand: "prullenmand",
  verwijderd: "prullenmand",
  junk: "spam",
  spam: "spam",
  ongewenst: "spam",
  archive: "archief",
  archief: "archief",
  gearchiveerd: "archief",
};

// Zoekt de map met een bepaalde rol (archief, prullenmand, ...) op de server.
// Zoekt DE map voor een rol. Staan er meerdere kandidaten (bv. "Sent" én
// "Sent Items"), dan wint de map met de officiële markering van de server;
// anders die met de meeste berichten — dat is de map die je echt gebruikt.
async function vindMapMetRol(imap, rol) {
  const lijst = await imap.list();
  const specials = Object.entries(ROL_PER_SPECIALUSE).find(([, r]) => r === rol);

  const kandidaten = lijst.filter((f) => {
    if (f.flags && (f.flags.has?.("\\Noselect") || f.flags.has?.("\\NonExistent"))) return false;
    if (specials && f.specialUse === specials[0]) return true;
    const naam = (f.name || "").toLowerCase();
    const pad = (f.path || "").toLowerCase();
    return ROL_PER_NAAM[naam] === rol || ROL_PER_NAAM[pad] === rol;
  });
  if (!kandidaten.length) return null;
  if (kandidaten.length === 1) return kandidaten[0].path;

  let beste = null;
  let besteScore = -1;
  for (const f of kandidaten) {
    let aantal = 0;
    try {
      aantal = (await imap.status(f.path, { messages: true })).messages || 0;
    } catch (e) { /* map niet opvraagbaar */ }
    const score = (specials && f.specialUse === specials[0] ? 1e9 : 0) + aantal;
    if (score > besteScore) { besteScore = score; beste = f; }
  }
  return beste ? beste.path : kandidaten[0].path;
}

// Zet of verwijdert de "gelezen"-vlag — precies wat een gewone mailclient doet.
async function markeerGelezen(uid, gelezen, folder) {
  if (!isConfigured()) throw new Error("De mailbox is nog niet gekoppeld.");
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder || "INBOX");
    try {
      if (gelezen) await imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      else await imap.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      return { ok: true, unread: !gelezen };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Verplaatst een mail naar een andere map (archiveren of naar de prullenmand).
// Valt terug op het markeren als verwijderd als de map niet bestaat.
async function verplaatsMail(uid, doelRol, folder) {
  if (!isConfigured()) throw new Error("De mailbox is nog niet gekoppeld.");
  const imap = client();
  await imap.connect();
  try {
    const doel = await vindMapMetRol(imap, doelRol);
    const bron = folder || "INBOX";
    const lock = await imap.getMailboxLock(bron);
    try {
      if (doel && doel !== bron) {
        await imap.messageMove(String(uid), doel, { uid: true });
        return { ok: true, naar: doel };
      }
      // Geen aparte map op deze server: dan markeren als verwijderd.
      await imap.messageFlagsAdd(String(uid), ["\\Deleted"], { uid: true });
      return { ok: true, naar: null, gemarkeerd: true };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Schrijft een verstuurde mail bij in de map "Verzonden" op de mailserver,
// zodat ze ook in Outlook of op je gsm terug te vinden is.
async function bewaarInVerzonden(raw) {
  if (!isConfigured() || !raw) return { ok: false };
  const imap = client();
  await imap.connect();
  try {
    const doel = await vindMapMetRol(imap, "verzonden");
    if (!doel) return { ok: false, reden: "geen map Verzonden gevonden" };
    await imap.append(doel, raw, ["\\Seen"]);
    return { ok: true, map: doel };
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Bewaart een onafgewerkte mail als concept op de mailserver, zodat je er
// later (ook vanaf je gsm of in Outlook) aan verder kan werken.
async function bewaarConcept(raw) {
  if (!isConfigured() || !raw) return { ok: false };
  const imap = client();
  await imap.connect();
  try {
    const doel = await vindMapMetRol(imap, "concepten");
    if (!doel) return { ok: false, reden: "geen map Concepten gevonden" };
    await imap.append(doel, raw, ["\\Draft", "\\Seen"]);
    return { ok: true, map: doel };
  } finally {
    await imap.logout().catch(() => {});
  }
}

async function listFolders() {
  if (!isConfigured()) return { configured: false, folders: [] };
  const imap = client();
  await imap.connect();
  try {
    const lijst = await imap.list();
    const folders = [];
    for (const f of lijst) {
      if (f.flags && (f.flags.has?.("\\Noselect") || f.flags.has?.("\\NonExistent"))) continue;
      const naam = (f.name || "").toLowerCase();
      const pad = (f.path || "").toLowerCase();
      const rol =
        ROL_PER_SPECIALUSE[f.specialUse] ||
        ROL_PER_NAAM[naam] ||
        ROL_PER_NAAM[pad] ||
        (pad === "inbox" ? "inbox" : "");

      let messages = null;
      let unseen = null;
      try {
        const st = await imap.status(f.path, { messages: true, unseen: true });
        messages = st.messages ?? null;
        unseen = st.unseen ?? null;
      } catch (e) {
        /* map kan niet opgevraagd worden — toon ze dan zonder teller */
      }

      folders.push({
        path: f.path,
        name: f.name || f.path,
        rol,
        specialUse: f.specialUse || "",
        messages,
        unseen,
      });
    }

    // Sommige mailservers hebben MEERDERE mappen die op hetzelfde neerkomen —
    // bv. zowel "Sent" (6800 berichten) als "Sent Items" (10 berichten), of
    // "Trash" naast "Deleted Items". Voor elke rol houden we er één over: die
    // met de officiële markering van de server, anders die met de meeste
    // berichten. De andere blijven gewoon zichtbaar onder hun eigen naam.
    const beste = new Map();
    for (const f of folders) {
      if (!f.rol) continue;
      const huidige = beste.get(f.rol);
      if (!huidige) { beste.set(f.rol, f); continue; }
      const fScore = (f.specialUse ? 1e9 : 0) + (f.messages || 0);
      const hScore = (huidige.specialUse ? 1e9 : 0) + (huidige.messages || 0);
      if (fScore > hScore) beste.set(f.rol, f);
    }
    for (const f of folders) {
      if (f.rol && beste.get(f.rol) !== f) f.rol = "";
    }

    return { configured: true, folders };
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

// Zoekt standaard in de hele mailbox: inbox + verzonden + archief + eigen
// mappen. Zo vind je ook terug wat je zelf ooit geantwoord hebt.
const ZOEK_MAPPEN_MAX = 6;

async function searchMails(query, limit = 30, alleMappen = true, config) {
  if (!config && !isConfigured()) return { configured: false, mails: [] };
  const q = (query || "").trim();
  if (!q) return { configured: true, mails: [] };
  const imap = client(config);
  await imap.connect();
  try {
    let paden = ["INBOX"];
    if (alleMappen) {
      try {
        const lijst = await imap.list();
        const rest = lijst
          .filter((f) => !(f.flags?.has?.("\\Noselect") || f.flags?.has?.("\\NonExistent")))
          .map((f) => f.path)
          .filter((p) => p && p.toUpperCase() !== "INBOX");
        // Prullenmand niet doorzoeken: wat je weggegooid hebt wil je niet terug in de resultaten.
        const zonderPrullenbak = rest.filter((p) => !/trash|prullen|deleted|verwijderd/i.test(p));
        paden = paden.concat(zonderPrullenbak.slice(0, ZOEK_MAPPEN_MAX));
      } catch (e) { /* lukt het niet, dan enkel de inbox */ }
    }

    const mails = [];
    for (const pad of paden) {
      try {
        const lock = await imap.getMailboxLock(pad);
        try {
          const uids = await imap.search({ text: q }, { uid: true });
          if (!uids || !uids.length) continue;
          const recentUids = uids.slice(-limit);
          // Enkel envelope + vlaggen: de fragmenten halen we apart en begrensd
          // op, zodat een mail met een grote bijlage het geheugen niet opvreet.
          for await (const msg of imap.fetch(recentUids, { envelope: true, flags: true }, { uid: true })) {
            mails.push({
              uid: msg.uid,
              from: msg.envelope.from?.[0]?.name || msg.envelope.from?.[0]?.address || "Onbekend",
              fromAddress: msg.envelope.from?.[0]?.address || "",
              subject: msg.envelope.subject || "(geen onderwerp)",
              date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
              unread: !msg.flags.has("\\Seen"),
              snippet: "",
              folder: pad,
            });
          }
        } finally {
          lock.release();
        }
      } catch (e) { /* map overslaan als ze niet doorzocht kan worden */ }
    }
    mails.sort((a, b) => new Date(b.date) - new Date(a.date));
    const resultaat = mails.slice(0, limit * 2);

    // Fragmenten enkel voor wat we effectief tonen, per map, met de begrensde
    // leesmethode.
    const perMap = new Map();
    for (const m of resultaat) {
      if (!perMap.has(m.folder)) perMap.set(m.folder, []);
      perMap.get(m.folder).push(m.uid);
    }
    for (const [pad, uidsVanMap] of perMap) {
      try {
        const lock = await imap.getMailboxLock(pad);
        try {
          for (const uid of uidsVanMap) {
            try {
              const dl = await imap.download(String(uid), undefined, { uid: true, maxBytes: SNIPPET_MAX_BYTES });
              if (!dl || !dl.content) continue;
              const stukken = [];
              let bytes = 0;
              for await (const chunk of dl.content) {
                stukken.push(chunk);
                bytes += chunk.length;
                if (bytes >= SNIPPET_MAX_BYTES) break;
              }
              const tekst = await extractPlainText(Buffer.concat(stukken));
              const mail = resultaat.find((x) => x.uid === uid && x.folder === pad);
              if (mail) mail.snippet = tekst.replace(/\s+/g, " ").trim().slice(0, 300);
            } catch (e) { /* fragment is bijzaak */ }
          }
        } finally {
          lock.release();
        }
      } catch (e) { /* map overslaan */ }
    }

    return { configured: true, mails: resultaat, mappen: paden.length };
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

// Zoekt in ALLE gekoppelde mailboxen tegelijk. Handig als je bv. een factuur
// zoekt die in de boekhoudingmailbox zit terwijl je in info@ aan het werken bent.
// Elk resultaat draagt de naam van de mailbox waar het uit komt.
async function searchAlleMailboxen(query, limitPerBox = 15) {
  const configs = settings.getAlleConfigs();
  if (!configs.length) return { configured: false, mails: [] };
  const resultaten = [];
  for (const c of configs) {
    try {
      const r = await searchMails(query, limitPerBox, true, c);
      for (const m of r.mails || []) resultaten.push({ ...m, mailbox: c.label, mailboxAdres: c.imapUser });
    } catch (e) {
      console.error(`Zoeken in ${c.imapUser} mislukt:`, e.message);
    }
  }
  resultaten.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { configured: true, mails: resultaten };
}

module.exports = {
  searchAlleMailboxen,
  fetchAllMails,
  fetchNieuweMails,
  fetchOudereMails,
  fetchVlaggen,
  fetchSnippetsForUids,
  fetchMailBody,
  listFolders,
  markeerGelezen,
  verplaatsMail,
  fetchAttachment,
  bewaarInVerzonden,
  bewaarConcept,
  searchMails,
  fetchMailsFromAddress,
  fetchFollowUps,
  isConfigured,
  ENVELOPE_CAP,
};
