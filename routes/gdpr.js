const express = require("express");

const router = express.Router();

const { pool }                              = require("../database");
const { sanitizeClientId, extractToken, loadClient, mapRow } = require("../lib/utils");
const { adminLimiter }                      = require("../lib/limiters");

function gdprAuth(req, res, clientId) {
  const client = loadClient(clientId);
  if (!client) { res.status(404).json({ error: "Client not found" }); return null; }
  if (extractToken(req) !== client.adminToken) { res.status(403).json({ error: "Zabranjen pristup" }); return null; }
  return client;
}

// ── Pretraga po emailu ──
router.get("/admin-gdpr-search/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    if (!gdprAuth(req, res, clientId)) return;

    const email = req.query.email;
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Neispravna email adresa." });

    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE clientid = $1 AND email = $2 ORDER BY id DESC",
      [clientId, email.trim().toLowerCase()]
    );
    res.json({ email, ukupno: rows.length, zahtjevi: rows.map(mapRow) });
  } catch (err) {
    console.error("GDPR SEARCH ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

// ── Export podataka ──
router.get("/admin-gdpr-export/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    const client = gdprAuth(req, res, clientId);
    if (!client) return;

    const email = req.query.email;
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Neispravna email adresa." });

    const safeEmail = email.trim().toLowerCase();
    const { rows } = await pool.query(
      "SELECT * FROM requests WHERE clientid = $1 AND email = $2 ORDER BY id DESC",
      [clientId, safeEmail]
    );

    res.setHeader("Content-Disposition", `attachment; filename="gdpr-export-${safeEmail}.json"`);
    res.json({
      izvoz_generiran: new Date().toLocaleString("hr-HR", { timeZone: "Europe/Zagreb" }),
      ordinacija: client.brandName,
      subjekt: safeEmail,
      podaci: rows.map(r => ({
        id:          r.id,
        ime:         r.name,
        email:       r.email,
        datum:       r.date,
        usluga:      r.service,
        napomena:    r.note,
        status:      r.status,
        zaprimljeno: r.primljeno,
        doktor:      r.doctorid || null,
      })),
    });
  } catch (err) {
    console.error("GDPR EXPORT ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

// ── Brisanje podataka ──
router.delete("/admin-gdpr-delete/:clientId", adminLimiter, async (req, res) => {
  try {
    const clientId = sanitizeClientId(req.params.clientId);
    if (!clientId) return res.status(400).json({ error: "Neispravan zahtjev." });
    if (!gdprAuth(req, res, clientId)) return;

    const email = req.query.email;
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Neispravna email adresa." });

    const safeEmail = email.trim().toLowerCase();
    const { rowCount } = await pool.query(
      "DELETE FROM requests WHERE clientid = $1 AND email = $2",
      [clientId, safeEmail]
    );

    const timestamp = new Date().toISOString();
    console.log(`[GDPR DELETE] ${timestamp} | klijent=${clientId} | email=${safeEmail} | obrisano=${rowCount} zapisa`);

    res.json({ ok: true, obrisano: rowCount, timestamp });
  } catch (err) {
    console.error("GDPR DELETE ERROR:", err);
    res.status(500).json({ error: "Greška." });
  }
});

module.exports = router;
