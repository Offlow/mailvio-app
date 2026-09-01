// mailer.js — verstuurt mail via de ingestelde SMTP-server (uitgaande server).
const nodemailer = require("nodemailer");
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

async function sendMail({ to, subject, text }) {
  if (!isConfigured()) {
    throw new Error("De uitgaande server (SMTP) is nog niet ingesteld.");
  }
  const c = settings.getConfig();
  const from = c.displayName ? `"${c.displayName}" <${c.smtpUser}>` : c.smtpUser;
  return transporter().sendMail({ from, to, subject, text });
}

module.exports = { isConfigured, sendMail };
