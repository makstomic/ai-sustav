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

async function getClinicDoctors(clientId, client) {
  let { rows } = await pool.query(
    "SELECT doctorid AS id, name FROM clinic_doctors WHERE clientid = $1 ORDER BY displayorder, id",
    [clientId]
  );
  if (rows.length === 0 && (client.doctors || []).length > 0) {
    for (let i = 0; i < client.doctors.length; i++) {
      const d = client.doctors[i];
      await pool.query(
        `INSERT INTO clinic_doctors (clientid, doctorid, name, displayorder) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [clientId, d.id, d.name, i]
      );
    }
    ({ rows } = await pool.query(
      "SELECT doctorid AS id, name FROM clinic_doctors WHERE clientid = $1 ORDER BY displayorder, id",
      [clientId]
    ));
  }
  return rows;
}

async function getClinicServices(clientId, client) {
  let { rows } = await pool.query(
    "SELECT name, duration FROM clinic_services WHERE clientid = $1 ORDER BY displayorder, id",
    [clientId]
  );
  if (rows.length === 0 && (client.services || []).length > 0) {
    for (let i = 0; i < client.services.length; i++) {
      const s = client.services[i];
      await pool.query(
        `INSERT INTO clinic_services (clientid, name, duration, displayorder) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [clientId, s.name, s.duration || 30, i]
      );
    }
    ({ rows } = await pool.query(
      "SELECT name, duration FROM clinic_services WHERE clientid = $1 ORDER BY displayorder, id",
      [clientId]
    ));
  }
  return rows;
}

// ── Booking server-side validation helpers ──

function parseCroatianDate(str) {
  const m = str.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\.\s+u\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, min] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;
  return { year: y, month: mo, day: d, hours: h, minutes: min };
}

function nowZagreb() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zagreb",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day"), hours: get("hour"), minutes: get("minute") };
}

function isInPast(parsed) {
  const now = nowZagreb();
  const pN  = parsed.year * 10000 + parsed.month * 100 + parsed.day;
  const nN  = now.year   * 10000 + now.month   * 100 + now.day;
  if (pN < nN) return true;
  if (pN > nN) return false;
  return (parsed.hours * 60 + parsed.minutes) <= (now.hours * 60 + now.minutes);
}

function isoWeekOf(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7);
  const w1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - w1) / 86400000 - 3 + (w1.getUTCDay() + 6) % 7) / 7);
}

function toMin(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

async function validateSlot(clientId, doctorId, parsed, duration) {
  const { year, month, day, hours, minutes } = parsed;
  const slotMin = hours * 60 + minutes;
  const slotEnd = slotMin + duration;

  if (doctorId) {
    const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dow     = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const isWeekA = isoWeekOf(year, month, day) % 2 !== 0;
    const dbDay   = isWeekA ? dow : dow + 10;

    let { rows: sched } = await pool.query(
      "SELECT starttime, endtime FROM doctor_schedules WHERE clientid=$1 AND doctorid=$2 AND dayofweek=$3",
      [clientId, doctorId, dbDay]
    );
    if (!sched[0] && !isWeekA) {
      ({ rows: sched } = await pool.query(
        "SELECT starttime, endtime FROM doctor_schedules WHERE clientid=$1 AND doctorid=$2 AND dayofweek=$3",
        [clientId, doctorId, dow]
      ));
    }
    if (!sched[0]) return "Doktor ne radi taj dan.";

    const workStart = toMin(sched[0].starttime);
    const workEnd   = toMin(sched[0].endtime);
    if (slotMin < workStart || slotEnd > workEnd)
      return "Termin je izvan radnog vremena.";

    const { rows: exc } = await pool.query(
      "SELECT type, time FROM schedule_exceptions WHERE clientid=$1 AND doctorid=$2 AND date=$3",
      [clientId, doctorId, isoDate]
    );
    if (exc.some(e => e.type === "block_day"))
      return "Taj dan nije dostupan.";
    const slotStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    if (exc.some(e => e.type === "block_slot" && e.time === slotStr))
      return "Taj termin nije dostupan.";
  }

  // Overlap check (duration-aware)
  const datePfx = `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}.%`;
  const { rows: existing } = await pool.query(
    `SELECT r.date, COALESCE(cs.duration, 30) AS duration
     FROM requests r
     LEFT JOIN clinic_services cs ON cs.clientid = r.clientid AND cs.name = r.service
     WHERE r.clientid = $1 AND r.doctorid = $2 AND r.status = 'potvrdjeno' AND r.date LIKE $3`,
    [clientId, doctorId, datePfx]
  );
  for (const row of existing) {
    const tm = row.date.match(/u\s+(\d{2}):(\d{2})$/);
    if (!tm) continue;
    const exStart = parseInt(tm[1]) * 60 + parseInt(tm[2]);
    const exEnd   = exStart + parseInt(row.duration);
    if (slotMin < exEnd && exStart < slotEnd)
      return "Taj termin je već zauzet.";
  }

  return null;
}

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
router.get("/config/:clientId", publicLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan ID." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const { adminToken: _omit, adminPasswordHash: _omit2, clinicEmail: _omit3, ...publicData } = client;

    const [doctors, services] = await Promise.all([
      getClinicDoctors(clientId, client),
      getClinicServices(clientId, client),
    ]);
    res.json({ ...publicData, doctors, services });
  } catch (err) {
    console.error("CONFIG ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
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

    const dbServices = await getClinicServices(safeClientId, client);
    const servicesText = dbServices
      .map(s => `- ${s.name}${s.duration ? ` (${s.duration} min)` : ""}`)
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

    const [dbDoctors, dbServices] = await Promise.all([
      getClinicDoctors(safeClientId, client),
      getClinicServices(safeClientId, client),
    ]);

    const allowedServices = dbServices.map(s => s.name);
    if (allowedServices.length > 0 && !allowedServices.includes(safeService))
      return res.status(400).json({ ok: false, error: "Neispravna usluga." });

    if (safeDoctorId && !dbDoctors.some(d => d.id === safeDoctorId))
      return res.status(400).json({ ok: false, error: "Doktor nije pronađen." });

    // ── Server-side termin validacija ──
    const parsed = parseCroatianDate(safeDate);
    if (!parsed)
      return res.status(400).json({ ok: false, error: "Neispravan format datuma." });
    if (isInPast(parsed))
      return res.status(400).json({ ok: false, error: "Ne možete rezervirati termin u prošlosti." });

    const svcData  = dbServices.find(s => s.name === safeService);
    const duration = svcData?.duration || 30;

    const slotError = await validateSlot(safeClientId, safeDoctorId, parsed, duration);
    if (slotError)
      return res.status(400).json({ ok: false, error: slotError });

    const doktor      = dbDoctors.find(d => d.id === safeDoctorId);
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
      const datObj   = new Date(datum);
      const dayOfWeek = datObj.getDay();
      // ISO week number: neparni = tjedan A, parni = tjedan B
      const d = new Date(datObj); d.setHours(0,0,0,0);
      d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
      const week1 = new Date(d.getFullYear(), 0, 4);
      const isoWeek = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
      const isWeekA = isoWeek % 2 !== 0;

      // Proba tjedan B (dbDay = dayOfWeek + 10), fallback na A
      const dbDay = isWeekA ? dayOfWeek : dayOfWeek + 10;
      const { rows: s1 } = await pool.query(
        "SELECT starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2 AND dayofweek = $3",
        [clientId, doctorId, dbDay]
      );
      if (s1[0]) {
        radnoVrijeme = `${s1[0].starttime}-${s1[0].endtime}`;
      } else if (!isWeekA) {
        // Nema tjedan B za taj dan — fallback na tjedan A
        const { rows: s2 } = await pool.query(
          "SELECT starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2 AND dayofweek = $3",
          [clientId, doctorId, dayOfWeek]
        );
        if (s2[0]) radnoVrijeme = `${s2[0].starttime}-${s2[0].endtime}`;
      }
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

    const doctors = await getClinicDoctors(clientId, client);
    const result = {};
    for (const doc of doctors) {
      const { rows } = await pool.query(
        "SELECT dayofweek, starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2",
        [clientId, doc.id]
      );
      if (rows.length > 0) {
        const weekA = {}, weekB = {};
        for (const r of rows) {
          if (r.dayofweek >= 10) weekB[String(r.dayofweek - 10)] = `${r.starttime}-${r.endtime}`;
          else                   weekA[String(r.dayofweek)]       = `${r.starttime}-${r.endtime}`;
        }
        result[doc.id] = Object.keys(weekB).length > 0
          ? { weekA, weekB }
          : weekA;
      }
    }
    res.json(result);
  } catch (err) {
    console.error("DOCTOR SCHEDULE ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

module.exports = router;
