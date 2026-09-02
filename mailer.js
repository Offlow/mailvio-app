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

// Bevat de handtekening HTML (bv. een logo of opmaak)?
function isHtmlHandtekening(h) {
  return /<[a-z][\s\S]*>/i.test(h || "");
}

// HTML naar leesbare tekst, voor mailprogramma's die geen opmaak tonen.
function htmlNaarTekst(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Plakt de vaste handtekening onderaan de mail, tenzij die er al in staat
// (bv. omdat de gebruiker ze zelf al in de tekst zette of het AI-voorstel ze
// al bevatte). Zo krijg je nooit twee keer dezelfde ondertekening.
// Waar het geciteerde origineel begint. Bij een antwoord of doorsturing staat
// onder je eigen tekst het volledige oude bericht met ">" ervoor. Je
// handtekening hoort ONDER JOUW TEKST, niet onderaan dat citaat — anders lijkt
// het alsof je onder het bericht van de ander tekent.
function splitsCitaat(body) {
  const regels = body.split(/\r?\n/);
  for (let i = 0; i < regels.length; i++) {
    // De kopregel die openReply() erboven zet, of de eerste geciteerde regel.
    if (/^Op .+ schreef .+:\s*$/.test(regels[i]) || /^>/.test(regels[i])) {
      return { eigen: regels.slice(0, i).join("\n").replace(/\s+$/, ""), citaat: regels.slice(i).join("\n") };
    }
  }
  return { eigen: body, citaat: "" };
}

function metHandtekening(text) {
  const handtekening = (settings.getConfig().handtekening || "").trim();
  const body = (text || "").replace(/\s+$/, "");
  if (!handtekening) return body;
  const platteHandtekening = isHtmlHandtekening(handtekening) ? htmlNaarTekst(handtekening) : handtekening;
  if (platteHandtekening && body.includes(platteHandtekening)) return body;
  const { eigen, citaat } = splitsCitaat(body);
  if (citaat) return `${eigen}\n\n${platteHandtekening}\n\n${citaat}`;
  return `${body}\n\n${platteHandtekening}`;
}

// Bouwt de opgemaakte versie van de mail: jouw tekst zoals getypt, met daaronder
// de handtekening met logo en opmaak. Enkel nodig als de handtekening HTML is.
function htmlVersie(text) {
  const handtekening = (settings.getConfig().handtekening || "").trim();
  if (!isHtmlHandtekening(handtekening)) return null;
  const platte = htmlNaarTekst(handtekening);
  let body = (text || "").replace(/\s+$/, "");
  // Staat de handtekening al als tekst in het bericht? Dan die eruit halen,
  // want ze komt er zo meteen in opgemaakte vorm onder.
  if (platte && body.includes(platte)) body = body.replace(platte, "").replace(/\s+$/, "");
  const { eigen, citaat } = splitsCitaat(body);
  const eigenHtml = escapeHtml(eigen).replace(/\r?\n/g, "<br>");
  const citaatHtml = citaat
    ? `<br><br><div style="color:#555;border-left:3px solid #ddd;padding-left:12px">${escapeHtml(citaat).replace(/\r?\n/g, "<br>")}</div>`
    : "";
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">${eigenHtml}<br><br>${handtekening}${citaatHtml}</div>`;
}

async function sendMail({ to, cc, subject, text, inReplyTo, references, attachments }) {
  if (!isConfigured()) {
    throw new Error("De uitgaande server (SMTP) is nog niet ingesteld.");
  }
  const c = settings.getConfig();
  const from = c.displayName ? `"${c.displayName}" <${c.smtpUser}>` : c.smtpUser;
  const bericht = { from, to, subject, text: metHandtekening(text) };
  // Handtekening met logo/opmaak? Dan sturen we de mail in twee versies mee:
  // opgemaakt voor wie dat kan tonen, platte tekst als terugval.
  const html = htmlVersie(text);
  if (html) bericht.html = html;
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
