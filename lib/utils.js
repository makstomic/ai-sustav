const fs   = require("fs");
const path = require("path");
const { logError } = require("./errorLog");

// ── Config validacija — konstante ─────────────────────────────────────────────

const EMAIL_RE     = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGBA_COLOR_RE = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/;
const COLOR_KEYS   = ["accent", "accent2", "accentSoft", "bgColor", "bgSoft"];

function isValidColor(val) {
  return typeof val === "string" && (HEX_COLOR_RE.test(val) || RGBA_COLOR_RE.test(val));
}

function isHttpsUrl(val) {
  if (typeof val !== "string") return false;
  try { return new URL(val).protocol === "https:"; } catch { return false; }
}

// Vraća niz grešaka (prazan = validan). Nikad ne uključuje tajne vrijednosti.
function validateClientConfig(config) {
  const e = [];

  // brandName — obavezan
  if (typeof config.brandName !== "string" || config.brandName.trim().length === 0)
    e.push("brandName: obavezan neprazan string");
  else if (config.brandName.length > 200)
    e.push("brandName: max 200 znakova");

  // clinicEmail — opcionalan, ali ako postoji mora biti validan email
  if (config.clinicEmail != null && config.clinicEmail !== "") {
    if (typeof config.clinicEmail !== "string" || !EMAIL_RE.test(config.clinicEmail.trim()))
      e.push("clinicEmail: neispravan email format");
  }

  // bookingUrl — opcionalan, ako postoji mora biti HTTPS
  if (config.bookingUrl != null && config.bookingUrl !== "") {
    if (!isHttpsUrl(config.bookingUrl))
      e.push("bookingUrl: mora biti HTTPS URL");
    else if (config.bookingUrl.length > 500)
      e.push("bookingUrl: max 500 znakova");
  }

  // theme — opcionalan objekt; ako postoji, sve boje moraju biti hex ili rgba
  if (config.theme != null) {
    if (typeof config.theme !== "object" || Array.isArray(config.theme)) {
      e.push("theme: mora biti objekt");
    } else {
      for (const key of COLOR_KEYS) {
        if (config.theme[key] != null && !isValidColor(config.theme[key]))
          e.push(`theme.${key}: mora biti hex (#rgb ili #rrggbb) ili rgba()`);
      }
    }
  }

  // doctors — opcionalan niz
  if (config.doctors != null) {
    if (!Array.isArray(config.doctors)) {
      e.push("doctors: mora biti niz");
    } else {
      config.doctors.forEach((d, i) => {
        if (!d || typeof d !== "object") { e.push(`doctors[${i}]: neispravan objekt`); return; }
        if (typeof d.id !== "string" || d.id.trim().length === 0)
          e.push(`doctors[${i}].id: obavezan`);
        else if (d.id.length > 100)
          e.push(`doctors[${i}].id: max 100 znakova`);
        if (typeof d.name !== "string" || d.name.trim().length === 0)
          e.push(`doctors[${i}].name: obavezan`);
        else if (d.name.length > 200)
          e.push(`doctors[${i}].name: max 200 znakova`);
      });
    }
  }

  // services — opcionalan niz; duration opcionalan, ali ako postoji mora biti 1–240
  if (config.services != null) {
    if (!Array.isArray(config.services)) {
      e.push("services: mora biti niz");
    } else {
      config.services.forEach((s, i) => {
        if (!s || typeof s !== "object") { e.push(`services[${i}]: neispravan objekt`); return; }
        if (typeof s.name !== "string" || s.name.trim().length === 0)
          e.push(`services[${i}].name: obavezan`);
        else if (s.name.length > 200)
          e.push(`services[${i}].name: max 200 znakova`);
        if (s.duration != null) {
          const dur = Number(s.duration);
          if (!Number.isInteger(dur) || dur < 1 || dur > 240)
            e.push(`services[${i}].duration: mora biti cijeli broj 1–240`);
        }
      });
    }
  }

  return e;
}

function sanitizeClientId(clientId) {
  if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId)) return null;
  return clientId;
}

function sanitizeCssValue(val) {
  if (typeof val !== "string") return null;
  if (/[<>"'`{}\\;]/.test(val)) return null;
  return val.slice(0, 100);
}

function sanitizeFontName(val) {
  if (typeof val !== "string") return null;
  if (!/^[a-zA-Z0-9 -]+$/.test(val)) return null;
  return val.slice(0, 60);
}

async function getSession(req, pool) {
  const token = req.cookies?.session;
  if (!token || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const { rows } = await pool.query(
    "SELECT clientid FROM sessions WHERE token = $1 AND expiresat > NOW()",
    [token]
  );
  return rows[0] || null;
}

function loadClient(clientId) {
  const filePath = path.join(__dirname, "..", "clients", `${clientId}.json`);
  if (!fs.existsSync(filePath)) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    logError(`CONFIG PARSE [${clientId}]`, err);
    return null;
  }
  const errors = validateClientConfig(config);
  if (errors.length > 0) {
    // Logiramo samo nazive polja i opise — nikad vrijednosti (ne izlažemo lozinke/emailove)
    logError(`CONFIG VALIDATION [${clientId}]`, new Error(errors.join("; ")));
    return null;
  }
  return config;
}

function mapRow(r) {
  return { ...r, clientId: r.clientid, doctorId: r.doctorid };
}

// Parsira "DD.MM.YYYY. u HH:MM" u { year, month, day, hours, minutes }
function parseCroatianDate(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\.\s+u\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, min] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;
  return { year: y, month: mo, day: d, hours: h, minutes: min };
}

// Pretvara Zagreb lokalno vrijeme (parsed) u UTC Date objekt
function parsedToTimestamp(parsed) {
  const { year, month, day, hours, minutes } = parsed;
  // Probe: treat input components as if UTC
  const probe = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
  // Find out what Zagreb local time that UTC probe represents
  const zagParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zagreb",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(probe);
  const get = type => parseInt(zagParts.find(p => p.type === type).value);
  // Correction: shift probe so Zagreb local matches our input
  const inputMs = Date.UTC(year, month - 1, day, hours, minutes);
  const zagMs   = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(probe.getTime() + (inputMs - zagMs));
}

// Formatira timestamp u "DD.MM.YYYY. u HH:MM" (Europe/Zagreb)
function formatZagreb(ts) {
  if (!ts) return null;
  const date = ts instanceof Date ? ts : new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zagreb",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.day}.${p.month}.${p.year}. u ${p.hour}:${p.minute}`;
}

module.exports = {
  sanitizeClientId, sanitizeCssValue, sanitizeFontName,
  getSession, loadClient, mapRow,
  parseCroatianDate, parsedToTimestamp, formatZagreb,
  validateClientConfig,
};
