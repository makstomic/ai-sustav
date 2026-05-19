const cron = require("node-cron");
const { pool }            = require("../database");
const { sendPatientMail } = require("../lib/mail");
const { loadClient }      = require("../lib/utils");
const { logError }         = require("../lib/errorLog");

async function getDoctorName(clientId, doctorId) {
  if (!doctorId) return "";
  const { rows } = await pool.query(
    "SELECT name FROM clinic_doctors WHERE clientid = $1 AND doctorid = $2",
    [clientId, doctorId]
  );
  return rows[0]?.name || "";
}

// ── Podsjetnik dan prije u 09:00 Zagreb ──────────────────────────────────────
//
// Query koristi appointmentat TIMESTAMPTZ umjesto date stringa.
// UPDATE ... WHERE reminder1dsentat IS NULL RETURNING * je atomska operacija:
// ako dvije instance servera rade istovremeno, samo ona koja prva izvrši UPDATE
// dobiva redove — druga nađe reminder1dsentat IS NOT NULL i preskače.
// Termin je "sutra" ako je Zagreb-lokalni datum appointmentAt = današnji datum + 1.

cron.schedule("0 9 * * *", async () => {
  try {
    const { rows } = await pool.query(`
      UPDATE requests
      SET reminder1dsentat = NOW()
      WHERE status = 'potvrdjeno'
        AND reminder1dsentat IS NULL
        AND email != '—'
        AND (appointmentat AT TIME ZONE 'Europe/Zagreb')::date
            = (NOW() AT TIME ZONE 'Europe/Zagreb')::date + 1
      RETURNING *
    `);

    console.log(`[REMINDER 1d] ${rows.length} termina za sutra`);

    for (const t of rows) {
      const client = loadClient(t.clientid);
      if (!client) continue;
      try {
        const doctorName = await getDoctorName(t.clientid, t.doctorid);
        await sendPatientMail(client, {
          to:      t.email,
          subject: `Podsjetnik za termin — ${client.brandName}`,
          text:
            `Poštovani ${t.name},\n\n` +
            `Podsjećamo vas da imate termin sutra.\n\n` +
            `Datum i vrijeme: ${t.date}\n` +
            `Usluga: ${t.service}\n\n` +
            (doctorName ? `Doktor: ${doctorName}\n\n` : "") +
            `Do viđenja,\n${client.brandName}`,
        });
        console.log(`[REMINDER 1d] Poslan → ${t.email}`);
      } catch (err) {
        logError("[REMINDER 1d] Mail greška", err);
      }
    }
  } catch (err) {
    logError("[REMINDER 1d] Query greška", err);
  }
}, { timezone: "Europe/Zagreb" });

// ── Podsjetnik 2 sata prije (svakih 30 min) ──────────────────────────────────
//
// Prozor ±15 min oko +2h pokriva točno jedno okidanje (30-min interval).
// appointmentat je u UTC-u, uspoređujemo direktno s NOW().
// Isti atomski UPDATE pattern kao gore.

cron.schedule("0,30 * * * *", async () => {
  try {
    const { rows } = await pool.query(`
      UPDATE requests
      SET reminder2hsentat = NOW()
      WHERE status = 'potvrdjeno'
        AND reminder2hsentat IS NULL
        AND email != '—'
        AND appointmentat >= NOW() + INTERVAL '105 minutes'
        AND appointmentat <= NOW() + INTERVAL '135 minutes'
      RETURNING *
    `);

    if (rows.length === 0) return;
    console.log(`[REMINDER 2h] ${rows.length} termina`);

    for (const t of rows) {
      const client = loadClient(t.clientid);
      if (!client) continue;
      try {
        const doctorName = await getDoctorName(t.clientid, t.doctorid);
        await sendPatientMail(client, {
          to:      t.email,
          subject: `Podsjetnik — termin za 2 sata — ${client.brandName}`,
          text:
            `Poštovani ${t.name},\n\n` +
            `Podsjećamo vas da imate termin za 2 sata.\n\n` +
            `Datum i vrijeme: ${t.date}\n` +
            `Usluga: ${t.service}\n\n` +
            (doctorName ? `Doktor: ${doctorName}\n\n` : "") +
            `Do viđenja,\n${client.brandName}`,
        });
        console.log(`[REMINDER 2h] Poslan → ${t.email}`);
      } catch (err) {
        logError("[REMINDER 2h] Mail greška", err);
      }
    }
  } catch (err) {
    logError("[REMINDER 2h] Query greška", err);
  }
}, { timezone: "Europe/Zagreb" });

// ── Mjesečno brisanje starih zapisa (GDPR retencija — 24 mjeseca) ────────────
//
// Briše po createdAt (pouzdan TIMESTAMPTZ), ne po id (bio je Snowflake timestamp
// koji se ne može sigurno koristiti za retenciju).

cron.schedule("0 3 1 * *", async () => {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM requests
      WHERE createdat < NOW() - INTERVAL '24 months'
    `);
    console.log(`[RETENCIJA] Obrisano ${rowCount} zapisa starijih od 24 mjeseca.`);
  } catch (err) {
    logError("[RETENCIJA] Greška", err);
  }
}, { timezone: "Europe/Zagreb" });
