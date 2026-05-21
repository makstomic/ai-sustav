const { Resend }    = require("resend");
const { logError }  = require("./errorLog");

const resend    = new Resend(process.env.RESEND_API_KEY);
const MAX_BODY  = 20_000;
const EMAIL_RE  = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// Uklanja header-injection znakove (\r, \n) i display-name breakere (<, >).
// Koristi se za subject i display-name dio from headera — NE za punu from adresu.
function cleanHeader(str, maxLen = 100) {
  if (typeof str !== "string") return "";
  return str.replace(/[\r\n<>]/g, "").trim().slice(0, maxLen);
}

function validateEmail(str) {
  return typeof str === "string" && EMAIL_RE.test(str.trim());
}

function maskEmail(email) {
  if (typeof email !== "string") return "?";
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return email.slice(0, 1) + "***" + email.slice(at);
}

// U produkciji maskira email; u dev-u ostavlja pun (za lakše debugiranje)
function logEmail(email) {
  return process.env.NODE_ENV === "production" ? maskEmail(email) : email;
}

async function sendMail({ to, subject, text, from, replyTo }) {
  if (!validateEmail(to)) {
    const err = new Error(`Neispravan to: ${logEmail(to)}`);
    logError("MAIL VALIDATION", err);
    throw err;
  }
  if (replyTo && !validateEmail(replyTo)) {
    const err = new Error(`Neispravan replyTo: ${logEmail(replyTo)}`);
    logError("MAIL VALIDATION", err);
    throw err;
  }

  const cleanSubject = cleanHeader(subject, 200);
  const safeFrom     = from || "Ordinova <info@ordinova.app>";
  const safeText     = typeof text === "string" ? text.slice(0, MAX_BODY) : "";

  const { data, error } = await resend.emails.send({
    from:    safeFrom,
    to,
    subject: cleanSubject,
    text:    safeText,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
  if (error) {
    logError("RESEND ERROR", new Error(error.message || "Mail nije poslan"));
    throw new Error(error.message || "Mail nije poslan");
  }
  return data;
}

function sendPatientMail(client, { to, subject, text }) {
  // brandName ide u display-name dio from headera — mora biti čist od <> i newlinea
  const safeBrand = cleanHeader(client.brandName, 80);
  const replyTo   = client.clinicEmail || process.env.CLINIC_EMAIL;
  return sendMail({
    to,
    subject,
    text,
    from:    `${safeBrand} <info@ordinova.app>`,
    replyTo,
  });
}

module.exports = { sendMail, sendPatientMail, cleanHeader, maskEmail, logEmail };
