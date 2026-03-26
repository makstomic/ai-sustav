require("dotenv").config();
const express  = require("express");
const path     = require("path");
const fs       = require("fs");
const OpenAI   = require("openai");
const { Resend } = require("resend");

const app  = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(express.json());
app.use(express.static("public"));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  next();
});

// Helper — učitaj JSON klijenta
function loadClient(clientId) {
  const filePath = path.join(__dirname, "clients", `${clientId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// Helper — pošalji mail (Resend)
async function sendMail({ to, subject, text }) {
  await resend.emails.send({
    from: process.env.EMAIL_FROM,   // npr. "DentBook <noreply@tvoja-domena.com>"
    to,
    subject,
    text,
  });
}

// ── RUTE ──

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "booking.html"));
});

app.get("/booking/:clientId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "booking.html"));
});

app.get("/config/:clientId", (req, res) => {
  const client = loadClient(req.params.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  res.json(client);
});

// Test mail
app.get("/test-mail", async (req, res) => {
  try {
    await sendMail({
      to:      process.env.CLINIC_EMAIL,
      subject: "TEST MAIL",
      text:    "Ako si ovo dobio, Resend radi.",
    });
    res.send("OK — poslan mail");
  } catch (e) {
    console.error("TEST MAIL ERROR:", e);
    res.status(500).send("FAIL — pogledaj terminal");
  }
});

// FAQ chatbot
app.post("/faq", async (req, res) => {
  try {
    const { message, clientId, history } = req.body;

    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ reply: "Ne mogu naći ordinaciju." });

    const servicesText = (client.services || [])
      .map((s) => `- ${s.name}${s.price ? `: ${s.price}` : ""}`)
      .join("\n");

    const systemPrompt = `
Ti si profesionalni AI asistent za: ${client.brandName}.
Jezik: hrvatski. Stil: kratko, jasno, profesionalno.

- Odgovaraj na pitanja o uslugama, cijenama, lokaciji i radnom vremenu
- Pomozi korisniku odabrati pravu uslugu ako je nesiguran
- Budi topao ali profesionalan — pacijenti su često nervozni

STROGA PRAVILA — NIKAD NE KRŠI:
- NIKAD ne potvrđuj, ne dogovaraj i ne predlažeš konkretne termine
- Ako pita za termin: "Termin možete zatražiti putem forme — ordinacija će vam se javiti mailom."
- NIKAD ne izmišljaj informacije koje nisu navedene ispod
- Ako nešto ne znaš: "Za tu informaciju kontaktirajte ordinaciju direktno."
- Ne spominji konkurenciju
- Ne daj medicinske dijagnoze ni savjete
- cijene uvijek u eurima

Usluge:
${servicesText || "- (nije definirano)"}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(Array.isArray(history) ? history : []),
        { role: "user", content: message },
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("FAQ ERROR:", err);
    res.status(500).json({ reply: "Došlo je do greške. Pokušajte kasnije." });
  }
});

// Booking — slanje maila ordinaciji
app.post("/booking", async (req, res) => {
  try {
    const { clientId, name, email, date, service, note } = req.body;

    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const toEmail = client.clinicEmail || process.env.CLINIC_EMAIL;


    // Spremi zahtjev u JSON fajl
const requestsDir = path.join(__dirname, "requests");
if (!fs.existsSync(requestsDir)) fs.mkdirSync(requestsDir);

const requestsFile = path.join(requestsDir, `${clientId}.json`);
const postojeci = fs.existsSync(requestsFile)
  ? JSON.parse(fs.readFileSync(requestsFile, "utf-8"))
  : [];

postojeci.push({
  id: Date.now(),
  name,
  email,
  date,
  service,
  note: note || "—",
  status: "na_cekanju",
  primljeno: new Date().toLocaleString("hr-HR"),
});

fs.writeFileSync(requestsFile, JSON.stringify(postojeci, null, 2));

    await sendMail({
      to:      toEmail,
      subject: `Novi zahtjev — ${client.brandName} — ${name}`,
      text:
        `Novi zahtjev za termin:\n\n` +
        `Ordinacija: ${client.brandName}\n` +
        `Ime:        ${name}\n` +
        `Email:      ${email}\n` +
        `Datum:      ${date}\n` +
        `Usluga:     ${service}\n` +
        `Napomena:   ${note || "—"}\n\n` +
        `Termin se ne potvrđuje automatski — potrebna ručna potvrda ordinacije.`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("BOOKING ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// Admin — dohvati zahtjeve
app.get("/admin/:clientId/:token", (req, res) => {
  const client = loadClient(req.params.clientId);
  if (!client) return res.status(404).send("Not found");
  if (req.params.token !== client.adminToken) return res.status(403).send("Zabranjen pristup");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});


app.get("/admin-data/:clientId", (req, res) => {
  const client = loadClient(req.params.clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const requestsFile = path.join(__dirname, "requests", `${req.params.clientId}.json`);
  const zahtjevi = fs.existsSync(requestsFile)
    ? JSON.parse(fs.readFileSync(requestsFile, "utf-8"))
    : [];

  res.json({ brandName: client.brandName, zahtjevi: zahtjevi.reverse() });
});

// Admin — potvrdi ili predloži termin
app.post("/admin-action", async (req, res) => {
  try {
    const { clientId, id, akcija, termin } = req.body;

    const client = loadClient(clientId);
    const requestsFile = path.join(__dirname, "requests", `${clientId}.json`);
    const zahtjevi = JSON.parse(fs.readFileSync(requestsFile, "utf-8"));

    const zahtjev = zahtjevi.find(z => z.id == id);
    if (!zahtjev) return res.status(404).json({ ok: false });

    zahtjev.status = akcija === "potvrdi" ? "potvrdjeno" : "predlozeno";

    fs.writeFileSync(requestsFile, JSON.stringify(zahtjevi, null, 2));

    const subject = akcija === "potvrdi"
      ? `Potvrda termina — ${client.brandName}`
      : `Prijedlog novog termina — ${client.brandName}`;

    const text = akcija === "potvrdi"
      ? `Poštovani ${zahtjev.name},\n\nVaš termin je potvrđen.\n\nDatum i vrijeme: ${termin}\nUsluga: ${zahtjev.service}\n\nDo videnja,\n${client.brandName}`
      : `Poštovani ${zahtjev.name},\n\nNažalost traženi termin nije dostupan.\n\nPredlažemo: ${termin}\n\nAko vam odgovara, javite nam se na povratni mail.\n\n${client.brandName}`;

    await sendMail({ to: zahtjev.email, subject, text });

    res.json({ ok: true });
  } catch (err) {
    console.error("ADMIN ACTION ERROR:", err);
    res.status(500).json({ ok: false });
  }
});




app.listen(PORT, () => {
  console.log(`Server radi na http://localhost:${PORT}/booking/simic`);
});