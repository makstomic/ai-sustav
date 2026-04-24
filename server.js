require("dotenv").config();
const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const bcrypt     = require("bcryptjs");
const OpenAI     = require("openai");
const { Resend } = require("resend");
const rateLimit  = require("express-rate-limit");
const cron       = require("node-cron");
const { pool, initDb } = require("./database");

const app  = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

function sanitizeClientId(clientId) {
  if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId)) return null;
  return clientId;
}

const faqLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { reply: "Previše zahtjeva. Pričekajte minutu i pokušajte opet." },
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { ok: false, error: "Previše zahtjeva. Pokušajte za sat vremena." },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { ok: false, error: "Previše zahtjeva." },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Previše zahtjeva." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public"));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// PostgreSQL vraća stupce malim slovima — mapiramo nazad u camelCase za frontend
function mapRow(r) {
  return { ...r, clientId: r.clientid, doctorId: r.doctorid };
}

function loadClient(clientId) {
  const filePath = path.join(__dirname, "clients", `${clientId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

async function sendMail({ to, subject, text }) {
  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
  });
  if (error) {
    console.error("RESEND ERROR:", error);
    throw new Error(error.message || "Mail nije poslan");
  }
  return data;
}

// ── RUTE ──

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "booking.html"));
});

app.get("/booking/:clientId", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).send("Invalid client ID");

  const client = loadClient(clientId);
  let html = fs.readFileSync(path.join(__dirname, "public", "booking.html"), "utf-8");

  if (client) {
    const t = client.theme || {};
    const vars = [];
    if (t.accent)     vars.push(`--accent: ${t.accent};`);
    if (t.accent2)    vars.push(`--accent-2: ${t.accent2};`);
    if (t.accentSoft) vars.push(`--accent-soft: ${t.accentSoft};`);
    if (t.bgColor)    vars.push(`--bg: ${t.bgColor};`);
    if (t.bgSoft)     vars.push(`--bg-soft: ${t.bgSoft};`);
    if (client.font)  vars.push(`--font: '${client.font}', ui-sans-serif, system-ui, sans-serif;`);

    let inject = "";
    if (client.font) {
      const fontUrl = `https://fonts.googleapis.com/css2?family=${client.font.replace(/ /g, "+")}:wght@400;500;600;700;800&display=swap`;
      inject += `  <link rel="stylesheet" href="${fontUrl}" />\n`;
    }
    if (vars.length) {
      inject += `  <style>:root { ${vars.join(" ")} }</style>\n`;
    }
    if (inject) {
      html = html.replace("</head>", inject + "</head>");
    }
  }

  res.send(html);
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/login/:clientId", (req, res) => {
  res.redirect(301, "/admin");
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: "Previše neuspjelih pokušaja. Pokušajte za 15 minuta." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

app.post("/admin-login", loginLimiter, async (req, res) => {
  const { clientId, password } = req.body;
  const safeClientId = sanitizeClientId(clientId);
  if (!safeClientId) return res.status(400).json({ ok: false, error: "Neispravan zahtjev." });
  if (typeof password !== "string" || password.length === 0 || password.length > 200)
    return res.status(400).json({ ok: false, error: "Neispravan zahtjev." });
  const client = loadClient(safeClientId);
  if (!client) return res.status(404).json({ ok: false, error: "Ordinacija nije pronađena." });

  let ok = false;
  if (client.adminPasswordHash) {
    ok = await bcrypt.compare(password, client.adminPasswordHash);
  } else {
    // Fallback: direktna usporedba dok se ne pokrene hash-passwords.js
    ok = password === client.adminToken;
    if (ok) console.warn(`[SECURITY] ${safeClientId}: lozinka nije hashirana — pokreni hash-passwords.js`);
  }

  if (!ok) return res.status(403).json({ ok: false, error: "Pogrešan ID klinike ili lozinka." });
  res.json({ ok: true, token: client.adminToken, brandName: client.brandName, doctors: client.doctors || [] });
});

app.get("/admin/:clientId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/config/:clientId", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan ID." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const { adminToken: _omit, adminPasswordHash: _omit3, clinicEmail: _omit2, ...publicData } = client;
  res.json(publicData);
});

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

app.post("/faq", faqLimiter, async (req, res) => {
  try {
    const { message, clientId, history } = req.body;

    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ reply: "Neispravan zahtjev." });
    if (typeof message !== "string" || message.trim().length === 0 || message.length > 500) {
      return res.status(400).json({ reply: "Poruka mora biti između 1 i 500 znakova." });
    }

    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ reply: "Ne mogu naći ordinaciju." });

    const safeHistory = Array.isArray(history)
      ? history
          .filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.length <= 1000)
          .slice(-10)
      : [];

    const servicesText = (client.services || [])
      .map((s) => `- ${s.name}${s.price ? `: ${s.price}` : ""}`)
      .join("\n");

    const locationText = client.location || "(lokacija nije definirana)";
    const phoneText = client.phone || "(telefon nije definiran)";
    const hoursText = client.workingHours || "(radno vrijeme nije definirano)";

    const systemPrompt = client.systemPrompt ? client.systemPrompt.trim() : `
Ti si profesionalni AI asistent za: ${client.brandName}.
Jezik: hrvatski. Stil: kratko, jasno, profesionalno.

Podaci o ordinaciji:
- Lokacija: ${locationText}
- Telefon: ${phoneText}
- Radno vrijeme: ${hoursText}

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

    if (!completion.choices?.length)
      return res.status(500).json({ reply: "Chatbot je trenutno nedostupan." });
    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("FAQ ERROR:", err);
    res.status(500).json({ reply: "Došlo je do greške. Pokušajte kasnije." });
  }
});

app.post("/booking", bookingLimiter, async (req, res) => {
  try {
    const { clientId, name, email, date, service, note, doctorId } = req.body;

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

    const safeName     = name.trim();
    const safeEmail    = email.trim().toLowerCase();
    const safeDate     = date.trim();
    const safeService  = service.trim();
    const safeNote     = typeof note === "string" ? note.trim().slice(0, 500) : "—";
    const safeDoctorId = typeof doctorId === "string" ? doctorId.trim().slice(0, 50) : "";

    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const allowedServices = (client.services || []).map(s => s.name);
    if (allowedServices.length > 0 && !allowedServices.includes(safeService))
      return res.status(400).json({ ok: false, error: "Neispravna usluga." });

    const doctors = client.doctors || [];
    if (safeDoctorId && !doctors.some(d => d.id === safeDoctorId))
      return res.status(400).json({ ok: false, error: "Doktor nije pronađen." });

    const doktor = doctors.find(d => d.id === safeDoctorId);
    const doktorNaziv = doktor ? doktor.name : null;
    const toEmail = client.clinicEmail || process.env.CLINIC_EMAIL;

    await pool.query(
      `INSERT INTO requests (id, clientId, name, email, date, service, note, status, primljeno, doctorId)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'na_cekanju', $8, $9)`,
      [Date.now(), safeClientId, safeName, safeEmail, safeDate, safeService, safeNote || "—",
       new Date().toLocaleString("hr-HR", { timeZone: "Europe/Zagreb" }), safeDoctorId]
    );

    res.json({ ok: true });

    sendMail({
      to:      toEmail,
      subject: `Novi zahtjev — ${client.brandName} — ${safeName}`,
      text:
        `Novi zahtjev za termin:\n\n` +
        `Ordinacija: ${client.brandName}\n` +
        (doktorNaziv ? `Doktor:     ${doktorNaziv}\n` : "") +
        `Ime:        ${safeName}\n` +
        `Email:      ${safeEmail}\n` +
        `Datum:      ${safeDate}\n` +
        `Usluga:     ${safeService}\n` +
        `Napomena:   ${safeNote || "—"}\n\n` +
        `Termin se ne potvrđuje automatski — potrebna ručna potvrda ordinacije.`,
    }).catch(err => console.error("BOOKING MAIL ERROR:", err));

    sendMail({
      to:      safeEmail,
      subject: `Zaprimili smo vaš zahtjev — ${client.brandName}`,
      text:
        `Poštovani ${safeName},\n\n` +
        `Hvala na zahtjevu za termin. Vaš zahtjev je zaprimljen i ordinacija će vas kontaktirati mailom s potvrdom ili prijedlogom alternativnog termina.\n\n` +
        (doktorNaziv ? `Doktor:  ${doktorNaziv}\n` : "") +
        `Datum:   ${safeDate}\n` +
        `Usluga:  ${safeService}\n\n` +
        `Lijep pozdrav,\n${client.brandName}`,
    }).catch(err => console.error("PATIENT CONFIRM MAIL ERROR:", err));
  } catch (err) {
    console.error("BOOKING ERROR:", err);
    res.status(500).json({ ok: false, error: "Greška pri slanju zahtjeva." });
  }
});

app.get("/admin-data/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (req.query.token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE clientid = $1 ORDER BY id DESC",
      [clientId]
    );
    res.json({ brandName: client.brandName, zahtjevi: rows.map(mapRow), doctors: client.doctors || [] });
  } catch (err) {
    console.error("ADMIN DATA ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

app.post("/admin-action", adminLimiter, async (req, res) => {
  try {
    const { clientId, token, id, akcija, termin } = req.body;

    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false, error: "Zabranjen pristup" });

    if (!["potvrdi", "predlozi"].includes(akcija))
      return res.status(400).json({ ok: false, error: "Neispravna akcija." });
    if (typeof termin !== "string" || termin.trim().length === 0 || termin.length > 100)
      return res.status(400).json({ ok: false, error: "Termin nije naveden." });

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE id = $1 AND clientid = $2",
      [id, safeClientId]
    );
    const zahtjev = rows[0];
    if (!zahtjev) return res.status(404).json({ ok: false });

    const noviStatus = akcija === "potvrdi" ? "potvrdjeno" : "predlozeno";
    await pool.query("UPDATE requests SET status = $1 WHERE id = $2", [noviStatus, id]);

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

app.post("/admin-cancel", adminLimiter, async (req, res) => {
  try {
    const { clientId, token, id } = req.body;
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false, error: "Zabranjen pristup" });

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE id = $1 AND clientid = $2",
      [id, safeClientId]
    );
    const zahtjev = rows[0];
    if (!zahtjev) return res.status(404).json({ ok: false });

    await pool.query("UPDATE requests SET status = 'otkazano' WHERE id = $1", [id]);
    res.json({ ok: true });

    const doktor = (client.doctors || []).find(d => d.id === zahtjev.doctorid);
    const bookingUrl = client.bookingUrl || "";
    const linkBlok = bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${bookingUrl}\n\nPutem iste forme možete se naručiti i kod drugog dostupnog doktora.\n`
      : `\nMolimo Vas da se javite ordinaciji za novi termin.\n`;

    sendMail({
      to:      zahtjev.email,
      subject: `Otkazivanje termina — ${client.brandName}`,
      text:
        `Poštovani ${zahtjev.name},\n\n` +
        `Nažalost, Vaš termin je otkazan.\n\n` +
        `Datum: ${zahtjev.date}\n` +
        `Usluga: ${zahtjev.service}\n` +
        (doktor ? `Doktor: ${doktor.name}\n` : "") +
        linkBlok +
        `\nIspričavamo se na neugodnosti.\n${client.brandName}`,
    }).catch(err => console.error("CANCEL MAIL ERROR:", err));
  } catch (err) {
    console.error("CANCEL ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/admin-kalendar/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const token = req.query.token || req.params.token;
    if (token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

    const doctorId = req.query.doctorId || "";
    const { rows } = doctorId
      ? await pool.query("SELECT * FROM requests WHERE clientid = $1 AND status = 'potvrdjeno' AND doctorid = $2", [clientId, doctorId])
      : await pool.query("SELECT * FROM requests WHERE clientid = $1 AND status = 'potvrdjeno'", [clientId]);

    const grupirano = {};
    for (const z of rows) {
      const match = z.date.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.\s+u\s+(\d{2}:\d{2})/);
      if (!match) continue;
      const [, dan, mjes, god, vrijeme] = match;
      const kljuc = `${god}-${mjes.padStart(2, "0")}-${dan.padStart(2, "0")}`;
      if (!grupirano[kljuc]) grupirano[kljuc] = [];
      grupirano[kljuc].push({ id: z.id, name: z.name, service: z.service, time: vrijeme });
    }
    res.json(grupirano);
  } catch (err) {
    console.error("KALENDAR ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

app.get("/termini/:clientId/:datum", publicLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });

    const datum = req.params.datum;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum))
      return res.status(400).json({ error: "Neispravan datum." });

    const [god, mjes, dan] = datum.split("-");
    const likeUzorak = `${dan}.${mjes}.${god}.%`;
    const doctorId = req.query.doctorId || "";

    const { rows: terminiRows } = doctorId
      ? await pool.query("SELECT date FROM requests WHERE clientid = $1 AND status = 'potvrdjeno' AND date LIKE $2 AND doctorid = $3", [clientId, likeUzorak, doctorId])
      : await pool.query("SELECT date FROM requests WHERE clientid = $1 AND status = 'potvrdjeno' AND date LIKE $2", [clientId, likeUzorak]);

    let zauzeti = terminiRows
      .map(z => { const m = z.date.match(/(\d{2}:\d{2})$/); return m ? m[1] : null; })
      .filter(Boolean);

    const { rows: iznimke } = await pool.query(
      "SELECT * FROM schedule_exceptions WHERE clientid = $1 AND doctorid = $2 AND date = $3",
      [clientId, doctorId, datum]
    );

    const blokiranDan = iznimke.some(i => i.type === "block_day");
    const blokiraniSlotovi = iznimke.filter(i => i.type === "block_slot" && i.time).map(i => i.time);
    zauzeti = [...new Set([...zauzeti, ...blokiraniSlotovi])];

    let radnoVrijeme = null;
    if (doctorId) {
      const dayOfWeek = new Date(datum).getDay();
      const { rows: schedRows } = await pool.query(
        "SELECT starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2 AND dayofweek = $3",
        [clientId, doctorId, dayOfWeek]
      );
      if (schedRows[0]) radnoVrijeme = `${schedRows[0].starttime}-${schedRows[0].endtime}`;
    }

    res.json({ zauzeti, blokiranDan, radnoVrijeme });
  } catch (err) {
    console.error("TERMINI ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

app.get("/doctor-schedule/:clientId", publicLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const doctors = client.doctors || [];
    const result = {};
    for (const doc of doctors) {
      const { rows } = await pool.query(
        "SELECT dayofweek, starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2",
        [clientId, doc.id]
      );
      if (rows.length > 0) {
        result[doc.id] = {};
        for (const r of rows) {
          result[doc.id][String(r.dayofweek)] = `${r.starttime}-${r.endtime}`;
        }
      }
    }
    res.json(result);
  } catch (err) {
    console.error("DOCTOR SCHEDULE ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

app.get("/admin-raspored/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (req.query.token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

    const doctorId = req.query.doctorId || "";
    if (!doctorId) return res.status(400).json({ error: "doctorId obavezan." });

    const { rows } = await pool.query(
      "SELECT dayofweek, starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2",
      [clientId, doctorId]
    );

    const schedule = {};
    for (const r of rows) {
      schedule[String(r.dayofweek)] = { startTime: r.starttime, endTime: r.endtime };
    }
    res.json({ schedule });
  } catch (err) {
    console.error("ADMIN RASPORED GET ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

app.post("/admin-raspored", adminLimiter, async (req, res) => {
  try {
    const { clientId, token, doctorId, schedule } = req.body;
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false });

    const doctors = client.doctors || [];
    if (!doctors.some(d => d.id === doctorId))
      return res.status(400).json({ ok: false, error: "Nepoznati doktor." });
    if (typeof schedule !== "object" || Array.isArray(schedule))
      return res.status(400).json({ ok: false });

    const pgClient = await pool.connect();
    try {
      await pgClient.query("BEGIN");
      for (let day = 0; day <= 6; day++) {
        const entry = schedule[String(day)];
        if (entry && entry.startTime && entry.endTime) {
          await pgClient.query(
            `INSERT INTO doctor_schedules (clientid, doctorid, dayofweek, starttime, endtime)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (clientid, doctorid, dayofweek) DO UPDATE SET starttime = $4, endtime = $5`,
            [safeClientId, doctorId, day, entry.startTime, entry.endTime]
          );
        } else {
          await pgClient.query(
            "DELETE FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2 AND dayofweek = $3",
            [safeClientId, doctorId, day]
          );
        }
      }
      await pgClient.query("COMMIT");
    } catch (e) {
      await pgClient.query("ROLLBACK");
      throw e;
    } finally {
      pgClient.release();
    }

    // Pronađi potvrđene termine ovog doktora koji padaju izvan novog rasporeda
    const { rows: potvrdjeni } = await pool.query(
      "SELECT * FROM requests WHERE clientid = $1 AND doctorid = $2 AND status = 'potvrdjeno'",
      [safeClientId, doctorId]
    );

    const konflikti = potvrdjeni.filter(z => {
      const match = z.date.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.\s+u\s+(\d{2}):(\d{2})/);
      if (!match) return false;
      const [, dan, mjes, god, sati, min] = match;
      const datum = new Date(parseInt(god), parseInt(mjes) - 1, parseInt(dan));
      const dayOfWeek = datum.getDay();
      const entry = schedule[String(dayOfWeek)];
      if (!entry) return true; // doktor taj dan više ne radi
      const [startH, startM] = entry.startTime.split(":").map(Number);
      const [endH, endM]     = entry.endTime.split(":").map(Number);
      const terminMin = parseInt(sati) * 60 + parseInt(min);
      return terminMin < startH * 60 + startM || terminMin >= endH * 60 + endM;
    });

    res.json({ ok: true, otkazano: konflikti.length });

    // Otkaži konflikte i obavijesti pacijente async nakon odgovora
    const doktor = doctors.find(d => d.id === doctorId);
    const bookingUrl = client.bookingUrl || "";
    const linkBlok = bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${bookingUrl}\n`
      : `\nMolimo Vas da se javite ordinaciji za novi termin.\n`;

    for (const z of konflikti) {
      await pool.query("UPDATE requests SET status = 'otkazano' WHERE id = $1", [z.id]);
      sendMail({
        to:      z.email,
        subject: `Otkazivanje termina — ${client.brandName}`,
        text:
          `Poštovani ${z.name},\n\n` +
          `Nažalost, Vaš termin je otkazan zbog promjene rasporeda ordinacije.\n\n` +
          `Datum: ${z.date}\n` +
          `Usluga: ${z.service}\n` +
          (doktor ? `Doktor: ${doktor.name}\n` : "") +
          linkBlok +
          `\nIspričavamo se na neugodnosti.\n${client.brandName}`,
      }).catch(err => console.error(`RASPORED CANCEL MAIL ERROR (${z.email}):`, err));
    }
  } catch (err) {
    console.error("ADMIN RASPORED POST ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/admin-iznimke/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (req.query.token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

    const { doctorId = "", year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: "year i month obavezni." });

    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const { rows } = await pool.query(
      "SELECT * FROM schedule_exceptions WHERE clientid = $1 AND doctorid = $2 AND date LIKE $3",
      [clientId, doctorId, `${prefix}-%`]
    );
    res.json(rows);
  } catch (err) {
    console.error("ADMIN IZNIMKE ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

app.post("/admin-iznimka", adminLimiter, async (req, res) => {
  try {
    const { clientId, token, doctorId = "", date, type, time, note = "" } = req.body;
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ ok: false, error: "Neispravan datum." });
    if (!["block_day", "block_slot"].includes(type))
      return res.status(400).json({ ok: false });
    if (type === "block_slot" && !time)
      return res.status(400).json({ ok: false, error: "Vrijeme obavezno." });

    const doctors = client.doctors || [];
    if (doctorId && !doctors.some(d => d.id === doctorId))
      return res.status(400).json({ ok: false, error: "Nepoznati doktor." });

    if (type === "block_day") {
      await pool.query(
        "DELETE FROM schedule_exceptions WHERE clientid = $1 AND doctorid = $2 AND date = $3 AND type = 'block_day'",
        [safeClientId, doctorId, date]
      );
    }

    const { rows: inserted } = await pool.query(
      "INSERT INTO schedule_exceptions (clientid, doctorid, date, type, time, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [safeClientId, doctorId, date, type, time || null, note.slice(0, 200)]
    );

    const [g, mj, d] = date.split("-");
    const doktor = doctors.find(x => x.id === doctorId);
    const bookingUrl = client.bookingUrl || "";
    const linkBlok = bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${bookingUrl}\n\nPutem iste forme možete odabrati i drugog dostupnog doktora.\n`
      : `\nMolimo Vas da se javite ordinaciji za novi termin.\n`;

    let zahvaceni = [];
    if (type === "block_day") {
      const pat = `${d}.${mj}.${g}.%`;
      const q = doctorId
        ? await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date LIKE $2 AND doctorid=$3", [safeClientId, pat, doctorId])
        : await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date LIKE $2", [safeClientId, pat]);
      zahvaceni = q.rows;
    } else if (type === "block_slot" && time) {
      const exactPat = `${d}.${mj}.${g}. u ${time}`;
      const q = doctorId
        ? await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date=$2 AND doctorid=$3", [safeClientId, exactPat, doctorId])
        : await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date=$2", [safeClientId, exactPat]);
      zahvaceni = q.rows;
    }

    res.json({ ok: true, id: inserted[0].id, otkazano: zahvaceni.length });

    for (const z of zahvaceni) {
      await pool.query("UPDATE requests SET status='otkazano' WHERE id=$1", [z.id]);
      sendMail({
        to:      z.email,
        subject: `Otkazivanje termina — ${client.brandName}`,
        text:
          `Poštovani ${z.name},\n\n` +
          `Nažalost, Vaš termin je otkazan jer doktor nije dostupan u navedenom terminu.\n\n` +
          `Datum: ${z.date}\n` +
          `Usluga: ${z.service}\n` +
          (doktor ? `Doktor: ${doktor.name}\n` : "") +
          linkBlok +
          `\nIspričavamo se na neugodnosti.\n${client.brandName}`,
      }).catch(err => console.error(`IZNIMKA MAIL ERROR (${z.email}):`, err));
    }
  } catch (err) {
    console.error("IZNIMKA ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

app.post("/admin-iznimka-delete", adminLimiter, async (req, res) => {
  try {
    const { clientId, token, id } = req.body;
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false });

    await pool.query("DELETE FROM schedule_exceptions WHERE id = $1 AND clientid = $2", [id, safeClientId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("IZNIMKA DELETE ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// ── Dnevni podsjetnik ──
cron.schedule("0 9 * * *", async () => {
  const sutra = new Date();
  sutra.setDate(sutra.getDate() + 1);
  const dan  = String(sutra.getDate()).padStart(2, "0");
  const mjes = String(sutra.getMonth() + 1).padStart(2, "0");
  const god  = sutra.getFullYear();

  const pattern = `${dan}.${mjes}.${god}.%`;
  const { rows: termini } = await pool.query(
    "SELECT * FROM requests WHERE status = 'potvrdjeno' AND date LIKE $1",
    [pattern]
  );

  console.log(`[REMINDER] ${dan}.${mjes}.${god}. — pronađeno ${termini.length} sutrašnjih termina`);

  for (const t of termini) {
    const client = loadClient(t.clientid);
    if (!client) continue;

    try {
      await sendMail({
        to:      t.email,
        subject: `Podsjetnik za termin — ${client.brandName}`,
        text:
          `Poštovani ${t.name},\n\n` +
          `Podsjećamo vas da imate termin sutra.\n\n` +
          `Datum i vrijeme: ${t.date}\n` +
          `Usluga: ${t.service}\n\n` +
          (t.doctorid && client.doctors?.find(d => d.id === t.doctorid)
            ? `Doktor: ${client.doctors.find(d => d.id === t.doctorid).name}\n\n`
            : "") +
          `Do viđenja,\n${client.brandName}`,
      });
      console.log(`[REMINDER] Poslan podsjetnik → ${t.email}`);
    } catch (err) {
      console.error(`[REMINDER] Greška za ${t.email}:`, err.message);
    }
  }
});

// ── Start ──
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server radi na http://localhost:${PORT}/booking/vrbic`);
    });
  })
  .catch(err => {
    console.error("[DB] Greška pri inicijalizaciji:", err);
    process.exit(1);
  });
