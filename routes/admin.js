const express = require("express");
const path    = require("path");
const bcrypt  = require("bcryptjs");

const router = express.Router();

const { pool }                              = require("../database");
const { sendMail, sendPatientMail }         = require("../lib/mail");
const { sanitizeClientId, extractToken, loadClient, mapRow } = require("../lib/utils");
const { adminLimiter, loginLimiter }        = require("../lib/limiters");

// ── Statičke stranice ──
router.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

router.get("/admin/:clientId", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

router.get("/login/:clientId", (req, res) => {
  res.redirect(301, "/admin");
});

// ── Login ──
router.post("/admin-login", loginLimiter, async (req, res) => {
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
    ok = password === client.adminToken;
    if (ok) console.warn(`[SECURITY] ${safeClientId}: lozinka nije hashirana — pokreni hash-passwords.js`);
  }

  if (!ok) return res.status(403).json({ ok: false, error: "Pogrešan ID klinike ili lozinka." });
  res.json({ ok: true, token: client.adminToken, brandName: client.brandName, doctors: client.doctors || [] });
});

// ── Podaci (zahtjevi) ──
router.get("/admin-data/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (extractToken(req) !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

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

// ── Potvrdi / predloži termin ──
router.post("/admin-action", adminLimiter, async (req, res) => {
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

    await sendPatientMail(client, { to: zahtjev.email, subject, text });
    res.json({ ok: true });
  } catch (err) {
    console.error("ADMIN ACTION ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// ── Otkaži termin ──
router.post("/admin-cancel", adminLimiter, async (req, res) => {
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
    const linkBlok = client.bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${client.bookingUrl}\n\nPutem iste forme možete se naručiti i kod drugog dostupnog doktora.\n`
      : `\nMolimo Vas da se javite ordinaciji za novi termin.\n`;

    sendPatientMail(client, {
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

// ── Kalendar potvrđenih termina ──
router.get("/admin-kalendar/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (extractToken(req) !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

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

// ── Raspored doktora ──
router.get("/admin-raspored/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (extractToken(req) !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

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

router.post("/admin-raspored", adminLimiter, async (req, res) => {
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

    const { rows: potvrdjeni } = await pool.query(
      "SELECT * FROM requests WHERE clientid = $1 AND doctorid = $2 AND status = 'potvrdjeno'",
      [safeClientId, doctorId]
    );

    const konflikti = potvrdjeni.filter(z => {
      const match = z.date.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.\s+u\s+(\d{2}):(\d{2})/);
      if (!match) return false;
      const [, dan, mjes, god, sati, min] = match;
      const datum = new Date(parseInt(god), parseInt(mjes) - 1, parseInt(dan));
      const entry = schedule[String(datum.getDay())];
      if (!entry) return true;
      const [startH, startM] = entry.startTime.split(":").map(Number);
      const [endH, endM]     = entry.endTime.split(":").map(Number);
      const terminMin = parseInt(sati) * 60 + parseInt(min);
      return terminMin < startH * 60 + startM || terminMin >= endH * 60 + endM;
    });

    res.json({ ok: true, otkazano: konflikti.length });

    const doktor = doctors.find(d => d.id === doctorId);
    const linkBlok = client.bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${client.bookingUrl}\n`
      : `\nMolimo Vas da se javite ordinaciji za novi termin.\n`;

    for (const z of konflikti) {
      await pool.query("UPDATE requests SET status = 'otkazano' WHERE id = $1", [z.id]);
      sendPatientMail(client, {
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

// ── Iznimke (slobodni dani / blokade) ──
router.get("/admin-iznimke/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (extractToken(req) !== client.adminToken) return res.status(403).json({ error: "Zabranjen pristup" });

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

router.post("/admin-iznimka", adminLimiter, async (req, res) => {
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
    const linkBlok = client.bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${client.bookingUrl}\n\nPutem iste forme možete odabrati i drugog dostupnog doktora.\n`
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
      sendPatientMail(client, {
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

router.post("/admin-iznimka-delete", adminLimiter, async (req, res) => {
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

// ── Test mail (samo localhost) ──
router.get("/test-mail", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1")
    return res.status(403).send("Zabranjen pristup.");
  try {
    await sendMail({ to: process.env.CLINIC_EMAIL, subject: "TEST MAIL", text: "Ako si ovo dobio, Resend radi." });
    res.send("OK — poslan mail");
  } catch (e) {
    console.error("TEST MAIL ERROR:", e);
    res.status(500).send("FAIL — pogledaj terminal");
  }
});

module.exports = router;
