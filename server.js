require("dotenv").config();
const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const OpenAI     = require("openai");
const { Resend } = require("resend");
const rateLimit  = require("express-rate-limit");

const app  = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Sanitizacija clientId — sprječava path traversal ──
// Dozvoljava samo slova, brojeve, crtice i podvlake
function sanitizeClientId(clientId) {
  if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId)) return null;
  return clientId;
}

// ── Rate limiteri ──
const faqLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minuta
  max: 15,               // max 15 poruka/min po IP-u
  message: { reply: "Previše zahtjeva. Pričekajte minutu i pokušajte opet." },
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 sat
  max: 5,                    // max 5 rezervacija/sat po IP-u
  message: { ok: false, error: "Previše zahtjeva. Pokušajte za sat vremena." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Middleware ──
app.use(express.json({ limit: "20kb" })); // ograničava veličinu tijela zahtjeva
app.use(express.static("public"));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
});

// Helper — učitaj JSON klijenta (clientId mora biti već sanitiziran)
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
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan ID." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  // Vrati samo javne podatke — NE adminToken
  const { adminToken: _omit, clinicEmail: _omit2, ...publicData } = client;
  res.json(publicData);
});

// Test mail — dostupan samo lokalno (127.0.0.1)
app.get("/test-mail", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    return res.status(403).send("Zabranjen pristup.");
  }
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
app.post("/faq", faqLimiter, async (req, res) => {
  try {
    const { message, clientId, history } = req.body;

    // Validacija inputa
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ reply: "Neispravan zahtjev." });
    if (typeof message !== "string" || message.trim().length === 0 || message.length > 500) {
      return res.status(400).json({ reply: "Poruka mora biti između 1 i 500 znakova." });
    }

    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ reply: "Ne mogu naći ordinaciju." });

    // Ograniči historiju na zadnjih 10 poruka kako bi se spriječilo slanje golemih konteksta
    const safeHistory = Array.isArray(history)
      ? history
          .filter(m => m && typeof m.role === "string" && typeof m.content === "string")
          .slice(-10)
      : [];

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
        ...safeHistory,
        { role: "user", content: message.trim() },
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("FAQ ERROR:", err);
    res.status(500).json({ reply: "Došlo je do greške. Pokušajte kasnije." });
  }
});

// Booking — slanje maila ordinaciji
app.post("/booking", bookingLimiter, async (req, res) => {
  try {
    const { clientId, name, email, date, service, note } = req.body;

    // Sanitizacija i validacija
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false, error: "Neispravan zahtjev." });

    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100)
      return res.status(400).json({ ok: false, error: "Neispravo ime." });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
      return res.status(400).json({ ok: false, error: "Neispravna email adresa." });
    if (typeof date !== "string" || date.trim().length === 0 || date.length > 50)
      return res.status(400).json({ ok: false, error: "Datum nije odabran." });
    if (typeof service !== "string" || service.trim().length === 0 || service.length > 100)
      return res.status(400).json({ ok: false, error: "Usluga nije odabrana." });

    const safeName    = name.trim();
    const safeEmail   = email.trim().toLowerCase();
    const safeDate    = date.trim();
    const safeService = service.trim();
    const safeNote    = typeof note === "string" ? note.trim().slice(0, 500) : "—";

    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const toEmail = client.clinicEmail || process.env.CLINIC_EMAIL;

    // Spremi zahtjev u JSON fajl
    const requestsDir = path.join(__dirname, "requests");
    if (!fs.existsSync(requestsDir)) fs.mkdirSync(requestsDir);

    const requestsFile = path.join(requestsDir, `${safeClientId}.json`);
    const postojeci = fs.existsSync(requestsFile)
      ? JSON.parse(fs.readFileSync(requestsFile, "utf-8"))
      : [];

    postojeci.push({
      id: Date.now(),
      name:    safeName,
      email:   safeEmail,
      date:    safeDate,
      service: safeService,
      note:    safeNote || "—",
      status: "na_cekanju",
      primljeno: new Date().toLocaleString("hr-HR"),
    });

    fs.writeFileSync(requestsFile, JSON.stringify(postojeci, null, 2));

    await sendMail({
      to:      toEmail,
      subject: `Novi zahtjev — ${client.brandName} — ${safeName}`,
      text:
        `Novi zahtjev za termin:\n\n` +
        `Ordinacija: ${client.brandName}\n` +
        `Ime:        ${safeName}\n` +
        `Email:      ${safeEmail}\n` +
        `Datum:      ${safeDate}\n` +
        `Usluga:     ${safeService}\n` +
        `Napomena:   ${safeNote || "—"}\n\n` +
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
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).send("Neispravan zahtjev.");
  const client = loadClient(clientId);
  if (!client) return res.status(404).send("Not found");
  if (req.params.token !== client.adminToken) return res.status(403).send("Zabranjen pristup");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/admin-data/:clientId", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (req.query.token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

  const requestsFile = path.join(__dirname, "requests", `${clientId}.json`);
  const zahtjevi = fs.existsSync(requestsFile)
    ? JSON.parse(fs.readFileSync(requestsFile, "utf-8"))
    : [];

  res.json({ brandName: client.brandName, zahtjevi: zahtjevi.reverse() });
});

// Admin — potvrdi ili predloži termin
app.post("/admin-action", async (req, res) => {
  try {
    const { clientId, token, id, akcija, termin } = req.body;

    // Autentikacija
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false, error: "Zabranjen pristup" });

    if (!["potvrdi", "predlozi"].includes(akcija))
      return res.status(400).json({ ok: false, error: "Neispravna akcija." });
    if (typeof termin !== "string" || termin.trim().length === 0 || termin.length > 100)
      return res.status(400).json({ ok: false, error: "Termin nije naveden." });

    const requestsFile = path.join(__dirname, "requests", `${safeClientId}.json`);
    const zahtjevi = JSON.parse(fs.readFileSync(requestsFile, "utf-8"));

    const zahtjev = zahtjevi.find(z => z.id == id);
    if (!zahtjev) return res.status(404).json({ ok: false });

    zahtjev.status = akcija === "potvrdi" ? "potvrdjeno" : "predlozeno";

    fs.writeFileSync(requestsFile, JSON.stringify(zahtjevi, null, 2));

    const subject = akcija === "potvrdi"
      ? `Potvrda termina — ${client.brandName}`
      : `Prijedlog novog termina — ${client.brandName}`;

    const text = akcija === "potvrdi"
      ? `Poštovani ${zahtjev.name},\n\nVaš termin je potvrđen.\n\nDatum i vrijeme: ${termin.trim()}\nUsluga: ${zahtjev.service}\n\nDo videnja,\n${client.brandName}`
      : `Poštovani ${zahtjev.name},\n\nNažalost traženi termin nije dostupan.\n\nPredlažemo: ${termin.trim()}\n\nAko vam odgovara, javite nam se na povratni mail.\n\n${client.brandName}`;

    await sendMail({ to: zahtjev.email, subject, text });

    res.json({ ok: true });
  } catch (err) {
    console.error("ADMIN ACTION ERROR:", err);
    res.status(500).json({ ok: false });
  }
});




// Admin — kalendar (potvrđeni termini grupirani po datumu)
app.get("/admin-kalendar/:clientId/:token", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (req.params.token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

  const requestsFile = path.join(__dirname, "requests", `${clientId}.json`);
  const zahtjevi = fs.existsSync(requestsFile)
    ? JSON.parse(fs.readFileSync(requestsFile, "utf-8"))
    : [];

  // Filtriraj potvrđene i grupiraj po datumu (format: "DD.MM.YYYY. u HH:MM")
  const grupirano = {};
  for (const z of zahtjevi.filter(z => z.status === "potvrdjeno")) {
    const match = z.date.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.\s+u\s+(\d{2}:\d{2})/);
    if (!match) continue;
    const [, dan, mjes, god, vrijeme] = match;
    const kljuc = `${god}-${mjes.padStart(2, "0")}-${dan.padStart(2, "0")}`;
    if (!grupirano[kljuc]) grupirano[kljuc] = [];
    grupirano[kljuc].push({
      id:      z.id,
      name:    z.name,
      service: z.service,
      time:    vrijeme,
    });
  }

  res.json(grupirano);
});

app.listen(PORT, () => {
  console.log(`Server radi na http://localhost:${PORT}/booking/simic`);
});