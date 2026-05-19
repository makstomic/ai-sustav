const express = require("express");
const path    = require("path");
const crypto  = require("crypto");
const bcrypt  = require("bcryptjs");

const router = express.Router();

const { pool }                              = require("../database");
const { sendMail, sendPatientMail }         = require("../lib/mail");
const { sanitizeClientId, getSession, loadClient, mapRow } = require("../lib/utils");
const { adminLimiter, loginLimiter }        = require("../lib/limiters");
const { logError, getLog }                  = require("../lib/errorLog");

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const isProduction        = process.env.NODE_ENV === "production";

function setCookieSession(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    secure:   isProduction,
    sameSite: "strict",
    path:     "/",
    maxAge:   SESSION_DURATION_MS,
  });
}

// ── Statičke stranice ──
router.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

router.get("/admin/:clientId", async (req, res) => {
  const clientId = sanitizeClientId(req.params.clientId);
  if (!clientId) return res.redirect("/admin");
  const session = await getSession(req, pool);
  if (!session || session.clientid !== clientId) return res.redirect("/admin");
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
  if (!client) return res.status(403).json({ ok: false, error: "Pogrešan ID klinike ili lozinka." });

  if (!client.adminPasswordHash) {
    logError("LOGIN SECURITY", new Error(`${safeClientId}: nema adminPasswordHash — pokreni hash-passwords.js`));
    return res.status(403).json({ ok: false, error: "Pogrešan ID klinike ili lozinka." });
  }

  const ok = await bcrypt.compare(password, client.adminPasswordHash);
  if (!ok) return res.status(403).json({ ok: false, error: "Pogrešan ID klinike ili lozinka." });

  const token     = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await Promise.all([
    pool.query("INSERT INTO sessions (token, clientid, expiresat) VALUES ($1, $2, $3)", [token, safeClientId, expiresAt]),
    pool.query("DELETE FROM sessions WHERE expiresat < NOW()"),
  ]);

  setCookieSession(res, token);
  res.json({ ok: true, brandName: client.brandName, doctors: client.doctors || [] });
});

// ── Logout ──
router.post("/admin-logout", async (req, res) => {
  const token = req.cookies?.session;
  if (token && /^[a-f0-9]{64}$/i.test(token)) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]).catch(() => {});
  }
  res.clearCookie("session", { httpOnly: true, secure: isProduction, sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

// ── Logout svih sessiona za klijenta ──
router.post("/admin-logout-all", adminLimiter, async (req, res) => {
  const session = await getSession(req, pool);
  if (!session) return res.status(403).json({ ok: false });
  await pool.query("DELETE FROM sessions WHERE clientid = $1", [session.clientid]);
  res.clearCookie("session", { httpOnly: true, secure: isProduction, sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

// ── Podaci (zahtjevi) ──
router.get("/admin-data/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const session = await getSession(req, pool);
    if (!session || session.clientid !== clientId) return res.status(403).json({ error: "Zabranjen pristup" });

    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    await seedClinicData(clientId, client, pool);

    const [{ rows }, { rows: doctors }] = await Promise.all([
      pool.query("SELECT * FROM requests WHERE clientid = $1 ORDER BY id DESC", [clientId]),
      pool.query("SELECT doctorid AS id, name FROM clinic_doctors WHERE clientid = $1 ORDER BY displayorder, id", [clientId]),
    ]);
    res.json({ brandName: client.brandName, zahtjevi: rows.map(mapRow), doctors });
  } catch (err) {
    logError("ADMIN DATA ERROR", err);
    res.status(500).json({ error: "Greška." });
  }
});

// ── Potvrdi / predloži termin ──
router.post("/admin-action", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const client   = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false });

    const { id, akcija, termin } = req.body;

    if (!["potvrdi", "predlozi"].includes(akcija))
      return res.status(400).json({ ok: false, error: "Neispravna akcija." });
    if (typeof termin !== "string" || termin.trim().length === 0 || termin.length > 100)
      return res.status(400).json({ ok: false, error: "Termin nije naveden." });

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE id = $1 AND clientid = $2",
      [id, clientId]
    );
    const zahtjev = rows[0];
    if (!zahtjev) return res.status(404).json({ ok: false });

    if (akcija === "potvrdi") {
      const { rows: konflikt } = await pool.query(
        "SELECT id FROM requests WHERE clientid = $1 AND doctorid = $2 AND date = $3 AND status = 'potvrdjeno' AND id != $4",
        [clientId, zahtjev.doctorid, zahtjev.date, id]
      );
      if (konflikt.length > 0) {
        sendPatientMail(client, {
          to:      zahtjev.email,
          subject: `Traženi termin nije dostupan — ${client.brandName}`,
          text:
            `Poštovani ${zahtjev.name},\n\n` +
            `Nažalost, traženi termin (${zahtjev.date}) nije više dostupan jer ga je u međuvremenu rezervirao drugi pacijent.\n\n` +
            (client.bookingUrl
              ? `Molimo vas da odaberete drugi termin putem naše online forme:\n${client.bookingUrl}\n\n`
              : `Molimo vas da nas kontaktirate za novi termin.\n\n`) +
            `Ispričavamo se na neugodnosti.\n${client.brandName}`,
        }).catch(err => logError("KONFLIKT MAIL ERROR", err));
        return res.status(409).json({ ok: false, error: "Taj termin je već potvrđen drugom pacijentu." });
      }
    }

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
    if (err.code === "23505")
      return res.status(409).json({ ok: false, error: "Taj termin je upravo zauzet drugim rezervacijom." });
    logError("ADMIN ACTION ERROR", err);
    res.status(500).json({ ok: false });
  }
});

// ── Otkaži termin ──
router.post("/admin-cancel", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const client   = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false });

    const { id } = req.body;

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE id = $1 AND clientid = $2",
      [id, clientId]
    );
    const zahtjev = rows[0];
    if (!zahtjev) return res.status(404).json({ ok: false });

    await pool.query("UPDATE requests SET status = 'otkazano' WHERE id = $1", [id]);
    res.json({ ok: true });

    const doktor   = (client.doctors || []).find(d => d.id === zahtjev.doctorid);
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
    }).catch(err => logError("CANCEL MAIL ERROR", err));
  } catch (err) {
    logError("CANCEL ERROR", err);
    res.status(500).json({ ok: false });
  }
});

// ── Odbij zahtjev ──
router.post("/admin-odbij", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const client   = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false });

    const { id, reason = "" } = req.body;

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE id = $1 AND clientid = $2",
      [id, clientId]
    );
    const zahtjev = rows[0];
    if (!zahtjev) return res.status(404).json({ ok: false });
    if (zahtjev.status !== "na_cekanju") return res.status(400).json({ ok: false, error: "Zahtjev nije na čekanju." });

    const safeReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    await pool.query("UPDATE requests SET status = 'odbijeno' WHERE id = $1", [id]);
    res.json({ ok: true });

    if (zahtjev.email && zahtjev.email !== "—") {
      const linkBlok = client.bookingUrl
        ? `\nAko želite, možete odabrati drugi termin putem naše online forme:\n${client.bookingUrl}\n`
        : `\nMolimo Vas da nas kontaktirate za novi termin.\n`;

      sendPatientMail(client, {
        to:      zahtjev.email,
        subject: `Zahtjev za termin odbijen — ${client.brandName}`,
        text:
          `Poštovani ${zahtjev.name},\n\n` +
          `Nažalost, Vaš zahtjev za termin (${zahtjev.date}) je odbijen.\n\n` +
          (safeReason ? `Razlog: ${safeReason}\n\n` : "") +
          linkBlok +
          `\nIspričavamo se na neugodnosti.\n${client.brandName}`,
      }).catch(err => logError("ODBIJ MAIL ERROR", err));
    }
  } catch (err) {
    logError("ODBIJ ERROR", err);
    res.status(500).json({ ok: false });
  }
});

// ── Kalendar potvrđenih termina ──
router.get("/admin-kalendar/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const session = await getSession(req, pool);
    if (!session || session.clientid !== clientId) return res.status(403).json({ error: "Zabranjen pristup" });

    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

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
      grupirano[kljuc].push({ id: z.id, name: z.name, email: z.email, service: z.service, time: vrijeme, doctorId: z.doctorid, note: z.note });
    }
    res.json(grupirano);
  } catch (err) {
    logError("KALENDAR ERROR", err);
    res.status(500).json({ error: "Greška." });
  }
});

// ── Raspored doktora ──
router.get("/admin-raspored/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const session = await getSession(req, pool);
    if (!session || session.clientid !== clientId) return res.status(403).json({ error: "Zabranjen pristup" });

    const doctorId = req.query.doctorId || "";
    if (!doctorId) return res.status(400).json({ error: "doctorId obavezan." });

    const { rows } = await pool.query(
      "SELECT dayofweek, starttime, endtime FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2",
      [clientId, doctorId]
    );

    const schedule = {}, scheduleB = {};
    for (const r of rows) {
      if (r.dayofweek >= 10) scheduleB[String(r.dayofweek - 10)] = { startTime: r.starttime, endTime: r.endtime };
      else                   schedule[String(r.dayofweek)]        = { startTime: r.starttime, endTime: r.endtime };
    }
    res.json({ schedule, scheduleB });
  } catch (err) {
    logError("ADMIN RASPORED GET ERROR", err);
    res.status(500).json({ error: "Greška." });
  }
});

router.post("/admin-raspored", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const client   = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false });

    const { doctorId, schedule, scheduleB } = req.body;

    const { rows: doctors } = await pool.query(
      "SELECT doctorid AS id, name FROM clinic_doctors WHERE clientid = $1",
      [clientId]
    );
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
            [clientId, doctorId, day, entry.startTime, entry.endTime]
          );
        } else {
          await pgClient.query(
            "DELETE FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2 AND dayofweek = $3",
            [clientId, doctorId, day]
          );
        }
      }
      if (scheduleB && typeof scheduleB === "object" && !Array.isArray(scheduleB)) {
        for (let day = 0; day <= 6; day++) {
          const entry = scheduleB[String(day)];
          const dbDay = day + 10;
          if (entry && entry.startTime && entry.endTime) {
            await pgClient.query(
              `INSERT INTO doctor_schedules (clientid, doctorid, dayofweek, starttime, endtime)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (clientid, doctorid, dayofweek) DO UPDATE SET starttime = $4, endtime = $5`,
              [clientId, doctorId, dbDay, entry.startTime, entry.endTime]
            );
          } else {
            await pgClient.query(
              "DELETE FROM doctor_schedules WHERE clientid = $1 AND doctorid = $2 AND dayofweek = $3",
              [clientId, doctorId, dbDay]
            );
          }
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
      [clientId, doctorId]
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

    const doktor   = doctors.find(d => d.id === doctorId);
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
      }).catch(err => logError("MAIL ERROR", err));
    }
  } catch (err) {
    logError("ADMIN RASPORED POST ERROR", err);
    res.status(500).json({ ok: false });
  }
});

// ── Iznimke (slobodni dani / blokade) ──
router.get("/admin-iznimke/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const session = await getSession(req, pool);
    if (!session || session.clientid !== clientId) return res.status(403).json({ error: "Zabranjen pristup" });

    const { doctorId = "", year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: "year i month obavezni." });

    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const { rows } = await pool.query(
      "SELECT * FROM schedule_exceptions WHERE clientid = $1 AND doctorid = $2 AND date LIKE $3",
      [clientId, doctorId, `${prefix}-%`]
    );
    res.json(rows);
  } catch (err) {
    logError("ADMIN IZNIMKE ERROR", err);
    res.status(500).json({ error: "Greška." });
  }
});

router.post("/admin-iznimka", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const client   = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false });

    const { doctorId = "", date, type, time, note = "" } = req.body;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ ok: false, error: "Neispravan datum." });
    if (!["block_day", "block_slot"].includes(type))
      return res.status(400).json({ ok: false });
    if (type === "block_slot" && !time)
      return res.status(400).json({ ok: false, error: "Vrijeme obavezno." });

    const { rows: doctors } = await pool.query(
      "SELECT doctorid AS id, name FROM clinic_doctors WHERE clientid = $1",
      [clientId]
    );
    if (doctorId && !doctors.some(d => d.id === doctorId))
      return res.status(400).json({ ok: false, error: "Nepoznati doktor." });

    if (type === "block_day") {
      await pool.query(
        "DELETE FROM schedule_exceptions WHERE clientid = $1 AND doctorid = $2 AND date = $3 AND type = 'block_day'",
        [clientId, doctorId, date]
      );
    }

    const { rows: inserted } = await pool.query(
      "INSERT INTO schedule_exceptions (clientid, doctorid, date, type, time, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [clientId, doctorId, date, type, time || null, note.slice(0, 200)]
    );

    const [g, mj, d] = date.split("-");
    const doktor   = doctors.find(x => x.id === doctorId);
    const linkBlok = client.bookingUrl
      ? `\nNaručite se na novi termin putem naše online forme:\n${client.bookingUrl}\n\nPutem iste forme možete odabrati i drugog dostupnog doktora.\n`
      : `\nMolimo Vas da se javite ordinaciji za novi termin.\n`;

    let zahvaceni = [];
    if (type === "block_day") {
      const pat = `${d}.${mj}.${g}.%`;
      const q = doctorId
        ? await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date LIKE $2 AND doctorid=$3", [clientId, pat, doctorId])
        : await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date LIKE $2", [clientId, pat]);
      zahvaceni = q.rows;
    } else if (type === "block_slot" && time) {
      const exactPat = `${d}.${mj}.${g}. u ${time}`;
      const q = doctorId
        ? await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date=$2 AND doctorid=$3", [clientId, exactPat, doctorId])
        : await pool.query("SELECT * FROM requests WHERE clientid=$1 AND status='potvrdjeno' AND date=$2", [clientId, exactPat]);
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
      }).catch(err => logError("MAIL ERROR", err));
    }
  } catch (err) {
    logError("IZNIMKA ERROR", err);
    res.status(500).json({ ok: false });
  }
});

router.post("/admin-iznimka-delete", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const { id } = req.body;

    await pool.query("DELETE FROM schedule_exceptions WHERE id = $1 AND clientid = $2", [id, clientId]);
    res.json({ ok: true });
  } catch (err) {
    logError("IZNIMKA DELETE ERROR", err);
    res.status(500).json({ ok: false });
  }
});

// ── Ručni unos termina s telefona ──
router.post("/admin-phone-booking", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false, error: "Zabranjen pristup." });

    const clientId = session.clientid;
    const client   = loadClient(clientId);
    if (!client) return res.status(404).json({ ok: false });

    const { doctorId = "", date, name, service, email = "—", note = "—" } = req.body;

    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100)
      return res.status(400).json({ ok: false, error: "Neispravan naziv pacijenta." });
    if (typeof date !== "string" || date.trim().length === 0 || date.length > 50)
      return res.status(400).json({ ok: false, error: "Datum nije odabran." });
    if (typeof service !== "string" || service.trim().length === 0 || service.length > 100)
      return res.status(400).json({ ok: false, error: "Usluga nije odabrana." });

    const [{ rows: dbDoctors }, { rows: dbServices }] = await Promise.all([
      pool.query("SELECT doctorid AS id FROM clinic_doctors WHERE clientid = $1", [clientId]),
      pool.query("SELECT name FROM clinic_services WHERE clientid = $1", [clientId]),
    ]);

    const allowedServices = dbServices.map(s => s.name);
    if (allowedServices.length > 0 && !allowedServices.includes(service.trim()))
      return res.status(400).json({ ok: false, error: "Neispravna usluga." });

    if (doctorId && !dbDoctors.some(d => d.id === doctorId))
      return res.status(400).json({ ok: false, error: "Nepoznati doktor." });

    const { rows: konflikt } = await pool.query(
      "SELECT id FROM requests WHERE clientid = $1 AND doctorid = $2 AND date = $3 AND status = 'potvrdjeno'",
      [clientId, doctorId, date.trim()]
    );
    if (konflikt.length > 0)
      return res.status(409).json({ ok: false, error: "Taj termin je već zauzet." });

    const primljeno = new Date().toLocaleString("hr-HR", { timeZone: "Europe/Zagreb" });
    const safeEmail = typeof email === "string" && email.trim().length > 0 ? email.trim().slice(0, 200) : "—";

    await pool.query(
      `INSERT INTO requests (id, clientId, name, email, date, service, note, status, primljeno, doctorId)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'potvrdjeno', $8, $9)`,
      [Date.now(), clientId, name.trim(), safeEmail, date.trim(), service.trim(),
       typeof note === "string" ? note.trim().slice(0, 500) : "—", primljeno, doctorId]
    );

    if (safeEmail !== "—") {
      let doctorName = "";
      if (doctorId) {
        const { rows: dr } = await pool.query(
          "SELECT name FROM clinic_doctors WHERE clientid = $1 AND doctorid = $2",
          [clientId, doctorId]
        );
        if (dr[0]) doctorName = dr[0].name;
      }
      sendPatientMail(client, {
        to:      safeEmail,
        subject: `Potvrda termina — ${client.brandName}`,
        text:
          `Poštovani ${name.trim()},\n\n` +
          `Vaš termin je potvrđen.\n\n` +
          (doctorName ? `Doktor:  ${doctorName}\n` : "") +
          `Datum:   ${date.trim()}\n` +
          `Usluga:  ${service.trim()}\n\n` +
          `Lijep pozdrav,\n${client.brandName}`,
      }).catch(err => logError("PHONE BOOKING MAIL ERROR", err));
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ ok: false, error: "Taj termin je upravo zauzet drugim rezervacijom." });
    logError("PHONE BOOKING ERROR", err);
    res.status(500).json({ ok: false, error: "Greška pri upisu termina." });
  }
});

// ── Postavke: doktori i usluge ──

async function seedClinicData(clientId, client, pgPool) {
  const { rows: existingDr } = await pgPool.query(
    "SELECT id FROM clinic_doctors WHERE clientid = $1 LIMIT 1", [clientId]
  );
  if (existingDr.length === 0 && (client.doctors || []).length > 0) {
    for (let i = 0; i < client.doctors.length; i++) {
      const d = client.doctors[i];
      await pgPool.query(
        `INSERT INTO clinic_doctors (clientid, doctorid, name, displayorder)
         VALUES ($1, $2, $3, $4) ON CONFLICT (clientid, doctorid) DO NOTHING`,
        [clientId, d.id, d.name, i]
      );
    }
  }

  const { rows: existingSvc } = await pgPool.query(
    "SELECT id FROM clinic_services WHERE clientid = $1 LIMIT 1", [clientId]
  );
  if (existingSvc.length === 0 && (client.services || []).length > 0) {
    for (let i = 0; i < client.services.length; i++) {
      const s = client.services[i];
      await pgPool.query(
        `INSERT INTO clinic_services (clientid, name, duration, displayorder)
         VALUES ($1, $2, $3, $4) ON CONFLICT (clientid, name) DO NOTHING`,
        [clientId, s.name, s.duration || 30, i]
      );
    }
  }
}

router.get("/admin-postavke/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const session = await getSession(req, pool);
    if (!session || session.clientid !== clientId) return res.status(403).json({ error: "Zabranjen pristup" });

    const client = loadClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    await seedClinicData(clientId, client, pool);

    const { rows: doctors }  = await pool.query(
      "SELECT doctorid AS id, name FROM clinic_doctors WHERE clientid = $1 ORDER BY displayorder, id",
      [clientId]
    );
    const { rows: services } = await pool.query(
      "SELECT name, duration FROM clinic_services WHERE clientid = $1 ORDER BY displayorder, id",
      [clientId]
    );

    res.json({ doctors, services });
  } catch (err) {
    logError("ADMIN POSTAVKE ERROR", err);
    res.status(500).json({ error: "Greška." });
  }
});

router.post("/admin-dodaj-doktora", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const { name }  = req.body;

    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100)
      return res.status(400).json({ ok: false, error: "Neispravan naziv." });

    const doctorId = `dr_${Date.now()}`;
    const { rows: maxRow } = await pool.query(
      "SELECT COALESCE(MAX(displayorder), -1) AS m FROM clinic_doctors WHERE clientid = $1", [clientId]
    );
    const displayOrder = maxRow[0].m + 1;

    await pool.query(
      "INSERT INTO clinic_doctors (clientid, doctorid, name, displayorder) VALUES ($1, $2, $3, $4)",
      [clientId, doctorId, name.trim(), displayOrder]
    );
    res.json({ ok: true });
  } catch (err) {
    logError("DODAJ DOKTORA ERROR", err);
    res.status(500).json({ ok: false, error: "Greška pri dodavanju." });
  }
});

router.post("/admin-obrisi-doktora", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId  = session.clientid;
    const { doctorId } = req.body;

    if (typeof doctorId !== "string" || doctorId.trim().length === 0)
      return res.status(400).json({ ok: false, error: "Neispravan doctorId." });

    await pool.query(
      "DELETE FROM clinic_doctors WHERE clientid = $1 AND doctorid = $2",
      [clientId, doctorId.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    logError("OBRISI DOKTORA ERROR", err);
    res.status(500).json({ ok: false, error: "Greška pri brisanju." });
  }
});

router.post("/admin-dodaj-uslugu", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId      = session.clientid;
    const { name, duration } = req.body;

    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100)
      return res.status(400).json({ ok: false, error: "Neispravan naziv usluge." });

    const dur = parseInt(duration, 10);
    if (![15, 30, 45, 60, 90, 120].includes(dur))
      return res.status(400).json({ ok: false, error: "Neispravno trajanje." });

    const { rows: maxRow } = await pool.query(
      "SELECT COALESCE(MAX(displayorder), -1) AS m FROM clinic_services WHERE clientid = $1", [clientId]
    );
    const displayOrder = maxRow[0].m + 1;

    await pool.query(
      `INSERT INTO clinic_services (clientid, name, duration, displayorder)
       VALUES ($1, $2, $3, $4) ON CONFLICT (clientid, name) DO NOTHING`,
      [clientId, name.trim(), dur, displayOrder]
    );
    res.json({ ok: true });
  } catch (err) {
    logError("DODAJ USLUGU ERROR", err);
    res.status(500).json({ ok: false, error: "Greška pri dodavanju." });
  }
});

router.post("/admin-obrisi-uslugu", adminLimiter, async (req, res) => {
  try {
    const session = await getSession(req, pool);
    if (!session) return res.status(403).json({ ok: false });

    const clientId = session.clientid;
    const { name }  = req.body;

    if (typeof name !== "string" || name.trim().length === 0)
      return res.status(400).json({ ok: false, error: "Neispravan naziv." });

    await pool.query(
      "DELETE FROM clinic_services WHERE clientid = $1 AND name = $2",
      [clientId, name.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    logError("OBRISI USLUGU ERROR", err);
    res.status(500).json({ ok: false, error: "Greška pri brisanju." });
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
    logError("TEST MAIL ERROR", e);
    res.status(500).send("FAIL — pogledaj terminal");
  }
});

// ── Error log pregled ──
router.get("/admin-errors", adminLimiter, async (req, res) => {
  const session = await getSession(req, pool);
  if (!session) return res.status(403).json({ error: "Zabranjen pristup." });
  res.json(getLog());
});

module.exports = router;
