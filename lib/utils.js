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

function extractToken(req) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return req.query.token || req.body?.token || null;
}

function loadClient(clientId) {
  const filePath = path.join(__dirname, "..", "clients", `${clientId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function mapRow(r) {
  return { ...r, clientId: r.clientid, doctorId: r.doctorid };
}

module.exports = { sanitizeClientId, sanitizeCssValue, sanitizeFontName, extractToken, loadClient, mapRow };
