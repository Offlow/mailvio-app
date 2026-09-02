// mailer.js — verstuurt mail via de ingestelde SMTP-server (uitgaande server).
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const settings = require("./settings");

function isConfigured() {
  const c = settings.getConfig();
  return !!(c.smtpHost && c.smtpUser && c.smtpPassword);
}

function transporter() {
  const c = settings.getConfig();
  return nodemailer.createTransport({
    host: c.smtpHost,
    port: Number(c.smtpPort || 587),
    secure: Number(c.smtpPort || 587) === 465,
    auth: {
      user: c.smtpUser,
      pass: c.smtpPassword,
    },
  });
}

// Plakt de vaste handtekening onderaan de mail, tenzij die er al in staat
// (bv. omdat de gebruiker ze zelf al in de tekst zette of het AI-voorstel ze
// al bevatte). Zo krijg je nooit twee keer dezelfde ondertekening.
function metHandtekening(text) {
  const handtekening = (settings.getConfig().handtekening || "").trim();
  const body = (text || "").replace(/\s+$/, "");
  if (!handtekening) return body;
  if (body.includes(handtekening)) return body;
  return `${body}\n\n${handtekening}`;
}

async function sendMail({ to, cc, subject, text, inReplyTo, references, attachments }) {
  if (!isConfigured()) {
    throw new Error("De uitgaande server (SMTP) is nog niet ingesteld.");
  }
  const c = settings.getConfig();
  const from = c.displayName ? `"${c.displayName}" <${c.smtpUser}>` : c.smtpUser;
  const bericht = { from, to, subject, text: metHandtekening(text) };
  // Bijlagen komen binnen als base64 vanuit de browser.
  if (Array.isArray(attachments) && attachments.length) {
    bericht.attachments = attachments
      .filter((a) => a && a.filename && a.content)
      .map((a) => ({
        filename: String(a.filename),
        content: Buffer.from(String(a.content), "base64"),
        contentType: a.contentType || undefined,
      }));
  }
  if (cc && (Array.isArray(cc) ? cc.length : String(cc).trim())) bericht.cc = cc;
  // Zorgt dat een antwoord in dezelfde conversatie blijft hangen bij de
  // ontvanger (Outlook, Gmail, ...) in plaats van als los bericht te komen.
  if (inReplyTo) bericht.inReplyTo = inReplyTo;
  if (references) bericht.references = references;

  // De mail één keer opbouwen tot een volledig bericht, zodat we exact
  // hetzelfde bericht versturen én bewaren (zelfde Message-ID, zelfde inhoud).
  const raw = await new MailComposer(bericht).compile().build();

  const info = await transporter().sendMail({
    envelope: { from: c.smtpUser, to: [].concat(to || [], cc || []).filter(Boolean) },
    raw,
  });

  // Een verstuurde mail hoort ook in je map "Verzonden" te staan — anders zie
  // je ze niet terug in Outlook, op je gsm of in Mailvio zelf. SMTP doet dat
  // niet vanzelf, dus we schrijven ze er via IMAP zelf bij.
  try {
    const mailbox = require("./mailbox");
    await mailbox.bewaarInVerzonden(raw);
  } catch (e) {
    // De mail is wel degelijk verstuurd — dit mag nooit een fout opleveren.
    console.error("Kon de verstuurde mail niet in Verzonden bewaren:", e.message);
  }

  return info;
}

// Bouwt dezelfde mail op, maar verstuurt ze niet: ze wordt als concept
// bewaard op de mailserver.
async function saveDraft({ to, cc, subject, text, attachments }) {
  const c = settings.getConfig();
  const from = c.displayName ? `"${c.displayName}" <${c.smtpUser || c.imapUser}>` : (c.smtpUser || c.imapUser);
  const bericht = { from, to: to || "", subject: subject || "", text: metHandtekening(text) };
  if (cc && String(cc).trim()) bericht.cc = cc;
  if (Array.isArray(attachments) && attachments.length) {
    bericht.attachments = attachments
      .filter((a) => a && a.filename && a.content)
      .map((a) => ({
        filename: String(a.filename),
        content: Buffer.from(String(a.content), "base64"),
        contentType: a.contentType || undefined,
      }));
  }
  const raw = await new MailComposer(bericht).compile().build();
  const mailbox = require("./mailbox");
  return mailbox.bewaarConcept(raw);
}

module.exports = { isConfigured, sendMail, metHandtekening, saveDraft };
