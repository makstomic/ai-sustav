require("dotenv").config();
const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const OpenAI     = require("openai");
const { Resend } = require("resend");
const rateLimit  = require("express-rate-limit");
const cron       = require("node-cron");
const db         = require("./database");

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

const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuta
  max: 60,             // max 60 admin zahtjeva/min po IP-u
  message: { ok: false, error: "Previše zahtjeva." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Middleware ──
app.set("trust proxy", 1); // potrebno za Railway/reverse proxy (rate limiter)
app.use(express.json({ limit: "20kb" })); // ograničava veličinu tijela zahtjeva
app.use(express.static("public"));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
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
  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,   // npr. "DentBook <noreply@tvoja-domena.com>"
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

// ── Generic admin login stranica ──
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Backward compat — stari linkovi s clientId u URL-u
app.get("/login/:clientId", (req, res) => {
  res.redirect(301, "/admin");
});

// ── Admin login API ──
app.post("/admin-login", (req, res) => {
  const { clientId, password } = req.body;
  const safeClientId = sanitizeClientId(clientId);
  if (!safeClientId) return res.status(400).json({ ok: false, error: "Neispravan zahtjev." });
  const client = loadClient(safeClientId);
  if (!client) return res.status(404).json({ ok: false, error: "Ordinacija nije pronađena." });
  if (!password || password !== client.adminToken)
    return res.status(403).json({ ok: false, error: "Pogrešna lozinka." });
  res.json({ ok: true, token: client.adminToken, brandName: client.brandName, doctors: client.doctors || [] });
});

// ── Admin panel (novi URL bez tokena) ──
app.get("/admin/:clientId", (req, res) => {
  // Samo jedan segment → nova login-based ruta
  res.sendFile(path.join(__dirname, "public", "admin.html"));
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

Služiš kao informativni chatbot za dentalne ordinacije na hrvatskom jeziku. Tvoj zadatak je pružiti korisnicima osnovne informacije o ordinaciji, uključujući:

- cijene usluga (navedi jasne primjere ili tablicu s cijenama)
- lokaciju ordinacije
- radno vrijeme ordinacije

NAGLASAK: Ne primaš rezervacije termina! Kada korisnik izrazi želju za naručivanjem termina (npr. napiše "želim naručiti termin" ili slično), uvijek ga preusmjeriš na posebnu web-formu s kalendarom za odabir termina, ljubazno objasniš da se termini rezerviraju putem te forme te da će dobiti potvrdu naručenog termina unutar radnog vremena ordinacije.

Prije davanja podataka, analiziraj korisnički upit kako bi ispravno odredio koju informaciju traži (cijena, lokacija, radno vrijeme, naručivanje). Započni odgovore davanjem potrebnih informacija ili uputa, a dijalog uvijek završavaj jasnom i profesionalnom rečenicom.

Format outputa:
- Odgovori na hrvatskom jeziku, sažeto i informativno.
- Cjenik navedi u odvojenim stavkama (ili tablici ako je potrebno).
- Ako korisnik pita za naručivanje termina, obavezno preusmjeri na formu i navedenu proceduru.
- Ukoliko korisnik postavi više pitanja, odgovori jasno na svako posebno.

Persistiraj dok nisi siguran da su sve informacije korisniku jasne i potpune prije završetka odgovora. Razmišljaj korak po korak: najprije analiziraj upit i odredi što je prioritetan zahtjev, zatim izrađuj odgovor.

Primjer 1:  
Upit: "Koliko košta vađenje zuba i gdje se nalazite?"  
Odgovor:  
- Analiza: Traže se cijena i lokacija.  
- Formatiraj:  
Cijena vađenja zuba: 55 EUR  
Lokacija: Ulica Primjera 1, Zagreb  
Za ostale cijene ili informacije slobodno pitajte.

Primjer 2:  
Upit: "Želim naručiti termin za kontrolu."  
Odgovor:  
- Analiza: Korisnik želi rezervirati termin.  
- Formatiraj:  
Za rezervaciju termina, molimo Vas da ispunite našu online formu putem dostupnog kalendara. Nakon što odaberete termin, potvrdu ćete primiti unutar radnog vremena.

Primjer 3:  
Upit: "Koje su cijene i kada radite?"  
Odgovor:  
- Analiza: Zanimaju ga cijene i radno vrijeme.  
- Formatiraj:  
Cijene odabranih usluga:  
- Vađenje zuba: 55 EUR  
- Čišćenje kamenca: 35 EUR  
Radno vrijeme: pon-pet 8:00-19:00  
Za naručivanje termina koristite naš kalendar na web-stranici, a potvrdu ćete dobiti unutar radnog vremena.

(Pravi primjeri mogu biti duži te sadržavati više navedenih usluga, adresu i preciznije radno vrijeme, prema stvarnim podatcima ordinacije.)

Podsjetnik:  
Tvoj zadatak je pružati TOČNE informacije o cijeni, lokaciji i radnom vremenu dentalne ordinacije, ali naručivanje termina uvijek odvajaš i preusmjeravaš korisnike na namjensku online formu za rezervaciju.

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

// Booking — slanje maila ordinaciji
app.post("/booking", bookingLimiter, async (req, res) => {
  try {
    const { clientId, name, email, date, service, note, doctorId } = req.body;

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
    const safeDoctorId = typeof doctorId === "string" ? doctorId.trim().slice(0, 50) : "";

    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    // Validacija usluge — mora biti u listi klijenta
    const allowedServices = (client.services || []).map(s => s.name);
    if (allowedServices.length > 0 && !allowedServices.includes(safeService))
      return res.status(400).json({ ok: false, error: "Neispravna usluga." });

    // Validacija doktora — mora biti u listi klijenta
    const doctors = client.doctors || [];
    if (safeDoctorId && !doctors.some(d => d.id === safeDoctorId))
      return res.status(400).json({ ok: false, error: "Doktor nije pronađen." });

    const doktor = doctors.find(d => d.id === safeDoctorId);
    const doktorNaziv = doktor ? doktor.name : null;

    const toEmail = client.clinicEmail || process.env.CLINIC_EMAIL;

    // Spremi zahtjev u bazu
    db.prepare(`
      INSERT INTO requests (id, clientId, name, email, date, service, note, status, primljeno, doctorId)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'na_cekanju', ?, ?)
    `).run(
      Date.now(),
      safeClientId,
      safeName,
      safeEmail,
      safeDate,
      safeService,
      safeNote || "—",
      new Date().toLocaleString("hr-HR", { timeZone: "Europe/Zagreb" }),
      safeDoctorId
    );

    // Zahtjev je u bazi — odmah vrati uspjeh korisniku
    res.json({ ok: true });

    // Mail šaljemo nakon odgovora — greška maila ne utječe na korisnika
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
  } catch (err) {
    console.error("BOOKING ERROR:", err);
    res.status(500).json({ ok: false, error: "Greška pri slanju zahtjeva." });
  }
});



app.get("/admin-data/:clientId", adminLimiter, (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (req.query.token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

  const zahtjevi = db.prepare(
    "SELECT * FROM requests WHERE clientId = ? ORDER BY id DESC"
  ).all(clientId);

  res.json({ brandName: client.brandName, zahtjevi, doctors: client.doctors || [] });
});

// Admin — potvrdi ili predloži termin
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

    const zahtjev = db.prepare(
      "SELECT * FROM requests WHERE id = ? AND clientId = ?"
    ).get(id, safeClientId);
    if (!zahtjev) return res.status(404).json({ ok: false });

    const noviStatus = akcija === "potvrdi" ? "potvrdjeno" : "predlozeno";
    db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(noviStatus, id);
    zahtjev.status = noviStatus;

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

// Admin — otkaži termin
app.post("/admin-cancel", adminLimiter, async (req, res) => {
  try {
    const { clientId, token, id } = req.body;
    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ ok: false });
    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ ok: false });
    if (!token || token !== client.adminToken) return res.status(403).json({ ok: false, error: "Zabranjen pristup" });

    const zahtjev = db.prepare("SELECT * FROM requests WHERE id = ? AND clientId = ?").get(id, safeClientId);
    if (!zahtjev) return res.status(404).json({ ok: false });

    db.prepare("UPDATE requests SET status = 'otkazano' WHERE id = ?").run(id);

    await sendMail({
      to:      zahtjev.email,
      subject: `Otkazivanje termina — ${client.brandName}`,
      text:    `Poštovani ${zahtjev.name},\n\nNažalost, Vaš termin je otkazan.\n\nDatum: ${zahtjev.date}\nUsluga: ${zahtjev.service}\n\nMolimo Vas da se javite ordinaciji za novi termin.\n\n${client.brandName}`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("CANCEL ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// Admin — kalendar (potvrđeni termini grupirani po datumu)
app.get("/admin-kalendar/:clientId", adminLimiter, (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const token = req.query.token || req.params.token;
  if (token !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

  const doctorId = req.query.doctorId || "";
  const zahtjevi = doctorId
    ? db.prepare("SELECT * FROM requests WHERE clientId = ? AND status = 'potvrdjeno' AND doctorId = ?").all(clientId, doctorId)
    : db.prepare("SELECT * FROM requests WHERE clientId = ? AND status = 'potvrdjeno'").all(clientId);

  const grupirano = {};
  for (const z of zahtjevi) {
    const match = z.date.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.\s+u\s+(\d{2}:\d{2})/);
    if (!match) continue;
    const [, dan, mjes, god, vrijeme] = match;
    const kljuc = `${god}-${mjes.padStart(2, "0")}-${dan.padStart(2, "0")}`;
    if (!grupirano[kljuc]) grupirano[kljuc] = [];
    grupirano[kljuc].push({ id: z.id, name: z.name, service: z.service, time: vrijeme });
  }

  res.json(grupirano);
});

// Zauzeti termini za odabrani dan (booking kalendar) — opcionalno filtrirano po doktoru
app.get("/termini/:clientId/:datum", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });

  const datum = req.params.datum;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum))
    return res.status(400).json({ error: "Neispravan datum." });

  const [god, mjes, dan] = datum.split("-");
  const likeUzorak = `${dan}.${mjes}.${god}.%`;
  const doctorId = req.query.doctorId || "";

  const zahtjevi = doctorId
    ? db.prepare("SELECT date FROM requests WHERE clientId = ? AND status = 'potvrdjeno' AND date LIKE ? AND doctorId = ?").all(clientId, likeUzorak, doctorId)
    : db.prepare("SELECT date FROM requests WHERE clientId = ? AND status = 'potvrdjeno' AND date LIKE ?").all(clientId, likeUzorak);

  const zauzeti = zahtjevi
    .map(z => { const m = z.date.match(/(\d{2}:\d{2})$/); return m ? m[1] : null; })
    .filter(Boolean);

  res.json(zauzeti);
});

// ── Dnevni podsjetnik — svaki dan u 9:00 ──
cron.schedule("0 9 * * *", async () => {
  const sutra = new Date();
  sutra.setDate(sutra.getDate() + 1);
  const dan  = String(sutra.getDate()).padStart(2, "0");
  const mjes = String(sutra.getMonth() + 1).padStart(2, "0");
  const god  = sutra.getFullYear();

  // Traži sve potvrđene termine čiji datum počinje s "DD.MM.YYYY."
  const pattern = `${dan}.${mjes}.${god}.%`;
  const termini = db.prepare(
    "SELECT * FROM requests WHERE status = 'potvrdjeno' AND date LIKE ?"
  ).all(pattern);

  console.log(`[REMINDER] ${dan}.${mjes}.${god}. — pronađeno ${termini.length} sutrašnjih termina`);

  for (const t of termini) {
    const client = loadClient(t.clientId);
    if (!client) continue;

    const vrijemeMatch = t.date.match(/(\d{2}:\d{2})$/);
    const vrijeme = vrijemeMatch ? vrijemeMatch[1] : "";

    try {
      await sendMail({
        to:      t.email,
        subject: `Podsjetnik za termin — ${client.brandName}`,
        text:
          `Poštovani ${t.name},\n\n` +
          `Podsjećamo vas da imate termin sutra.\n\n` +
          `Datum i vrijeme: ${t.date}\n` +
          `Usluga: ${t.service}\n\n` +
          (t.doctorId && client.doctors?.find(d => d.id === t.doctorId)
            ? `Doktor: ${client.doctors.find(d => d.id === t.doctorId).name}\n\n`
            : "") +
          `Do viđenja,\n${client.brandName}`,
      });
      console.log(`[REMINDER] Poslan podsjetnik → ${t.email}`);
    } catch (err) {
      console.error(`[REMINDER] Greška za ${t.email}:`, err.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server radi na http://localhost:${PORT}/booking/vrbic`);
});