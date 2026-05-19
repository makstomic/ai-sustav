const fs   = require("fs");
const path = require("path");

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
  if (!token || typeof token !== "string" || token.length !== 64) return null;
  const { rows } = await pool.query(
    "SELECT clientid FROM sessions WHERE token = $1 AND expiresat > NOW()",
    [token]
  );
  return rows[0] || null;
}

function loadClient(clientId) {
  const filePath = path.join(__dirname, "..", "clients", `${clientId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
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
};
