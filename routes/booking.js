const express = require("express");
const path    = require("path");
const fs      = require("fs");
const OpenAI  = require("openai");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { pool }                                              = require("../database");
const { sendMail, sendPatientMail }                         = require("../lib/mail");
const { sanitizeClientId, sanitizeCssValue, sanitizeFontName, loadClient } = require("../lib/utils");
const { faqLimiter, bookingLimiter, publicLimiter }         = require("../lib/limiters");

// ── Booking stranica s temom klijenta ──
router.get("/booking/:clientId", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).send("Invalid client ID");

  const client = loadClient(clientId);
  let html = fs.readFileSync(path.join(__dirname, "..", "public", "booking.html"), "utf-8");

  if (client) {
    const t = client.theme || {};
    const vars = [];
    const safeAccent     = sanitizeCssValue(t.accent);
    const safeAccent2    = sanitizeCssValue(t.accent2);
    const safeAccentSoft = sanitizeCssValue(t.accentSoft);
    const safeBgColor    = sanitizeCssValue(t.bgColor);
    const safeBgSoft     = sanitizeCssValue(t.bgSoft);
    const safeFont       = sanitizeFontName(client.font);

    if (safeAccent)     vars.push(`--accent: ${safeAccent};`);
    if (safeAccent2)    vars.push(`--accent-2: ${safeAccent2};`);
    if (safeAccentSoft) vars.push(`--accent-soft: ${safeAccentSoft};`);
    if (safeBgColor)    vars.push(`--bg: ${safeBgColor};`);
    if (safeBgSoft)     vars.push(`--bg-soft: ${safeBgSoft};`);
    if (safeFont)       vars.push(`--font: '${safeFont}', ui-sans-serif, system-ui, sans-serif;`);

    let inject = "";
    if (safeFont) {
      const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(safeFont).replace(/%20/g, "+")}:wght@400;500;600;700;800&display=swap`;
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

// ── Config (bez tajnih polja) ──
router.get("/config/:clientId", (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.status(400).json({ error: "Neispravan ID." });
  const client = loadClient(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  const { adminToken: _omit, adminPasswordHash: _omit2, clinicEmail: _omit3, ...publicData } = client;
  res.json(publicData);
});

// ── FAQ chatbot ──
router.post("/faq", faqLimiter, async (req, res) => {
  try {
    const { message, clientId, history } = req.body;

    const safeClientId = sanitizeClientId(clientId);
    if (!safeClientId) return res.status(400).json({ reply: "Neispravan zahtjev." });
    if (typeof message !== "string" || message.trim().length === 0 || message.length > 500)
      return res.status(400).json({ reply: "Poruka mora biti između 1 i 500 znakova." });

    const client = loadClient(safeClientId);
    if (!client) return res.status(404).json({ reply: "Ne mogu naći ordinaciju." });

    const safeHistory = Array.isArray(history)
      ? history
          .filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.length <= 1000)
          .slice(-10)
      : [];

    const servicesText = (client.services || [])
      .map(s => `- ${s.name}${s.price ? `: ${s.price}` : ""}`)
      .join("\n");

    const systemPrompt = client.systemPrompt ? client.systemPrompt.trim() : `
Ti si profesionalni AI asistent za: ${client.brandName}.
Jezik: hrvatski. Stil: kratko, jasno, profesionalno.

Podaci o ordinaciji:
- Lokacija: ${client.location || "(nije definirano)"}
- Telefon: ${client.phone || "(nije definirano)"}
- Radno vrijeme: ${client.workingHours || "(nije definirano)"}

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

// ── Booking forma ──
router.post("/booking", bookingLimiter, async (req, res) => {
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

    const doktor      = doctors.find(d => d.id === safeDoctorId);
    const doktorNaziv = doktor ? doktor.name : null;
    const toEmail     = client.clinicEmail || process.env.CLINIC_EMAIL;
    const primljeno   = new Date().toLocaleString("hr-HR", { timeZone: "Europe/Zagreb" });

    await pool.query(
      `INSERT INTO requests (id, clientId, name, email, date, service, note, status, primljeno, doctorId)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'na_cekanju', $8, $9)`,
      [Date.now(), safeClientId, safeName, safeEmail, safeDate, safeService, safeNote || "—", primljeno, safeDoctorId]
    );

    res.json({ ok: true });

    // Obavijest klinici
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
        `Napomena:   ${safeNote || "—"}\n` +
        `Zaprimljeno: ${primljeno}\n\n` +
        `Termin se ne potvrđuje automatski — potrebna ručna potvrda ordinacije.`,
    }).catch(err => console.error("BOOKING MAIL ERROR:", err));

    // Potvrda pacijentu
    sendPatientMail(client, {
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

// ── Slobodni termini za datum ──
router.get("/termini/:clientId/:datum", publicLimiter, async (req, res) => {
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

    const blokiranDan     = iznimke.some(i => i.type === "block_day");
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

// ── Rasporedi doktora ──
router.get("/doctor-schedule/:clientId", publicLimiter, async (req, res) => {
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

module.exports = router;
