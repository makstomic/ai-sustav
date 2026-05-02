const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendMail({ to, subject, text, from, replyTo }) {
  const { data, error } = await resend.emails.send({
    from: from || "Ordinova <info@ordinova.app>",
    to,
    subject,
    text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });
  if (error) {
    console.error("RESEND ERROR:", error);
    throw new Error(error.message || "Mail nije poslan");
  }
  return data;
}

function sendPatientMail(client, { to, subject, text }) {
  return sendMail({
    to,
    subject,
    text,
    from:    `${client.brandName} <info@ordinova.app>`,
    replyTo: client.clinicEmail || process.env.CLINIC_EMAIL,
  });
}

module.exports = { sendMail, sendPatientMail };
