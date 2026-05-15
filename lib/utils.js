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

module.exports = { sanitizeClientId, sanitizeCssValue, sanitizeFontName, getSession, loadClient, mapRow };
