const cron = require("node-cron");
const { pool }              = require("../database");
const { sendPatientMail }   = require("../lib/mail");
const { loadClient }        = require("../lib/utils");

// ── Podsjetnik dan prije u 09:00 Zagreb ──
cron.schedule("0 7 * * *", { timezone: "Europe/Zagreb" }, async () => {
  const sutra = new Date();
  sutra.setDate(sutra.getDate() + 1);
  const dan  = String(sutra.getDate()).padStart(2, "0");
  const mjes = String(sutra.getMonth() + 1).padStart(2, "0");
  const god  = sutra.getFullYear();

  const { rows } = await pool.query(
    "SELECT * FROM requests WHERE status = 'potvrdjeno' AND date LIKE $1",
    [`${dan}.${mjes}.${god}.%`]
  );

  console.log(`[REMINDER 1d] ${dan}.${mjes}.${god}. — ${rows.length} termina`);

  for (const t of rows) {
    const client = loadClient(t.clientid);
    if (!client) continue;
    try {
      await sendPatientMail(client, {
        to:      t.email,
        subject: `Podsjetnik za termin — ${client.brandName}`,
        text:
          `Poštovani ${t.name},\n\n` +
          `Podsjećamo vas da imate termin sutra.\n\n` +
          `Datum i vrijeme: ${t.date}\n` +
          `Usluga: ${t.service}\n\n` +
          (t.doctorid && client.doctors?.find(d => d.id === t.doctorid)
            ? `Doktor: ${client.doctors.find(d => d.id === t.doctorid).name}\n\n`
            : "") +
          `Do viđenja,\n${client.brandName}`,
      });
      console.log(`[REMINDER 1d] Poslan → ${t.email}`);
    } catch (err) {
      console.error(`[REMINDER 1d] Greška za ${t.email}:`, err.message);
    }
  }
});

// ── Podsjetnik 2 sata prije (svaki sat u :00 i :30) ──
cron.schedule("0,30 * * * *", { timezone: "Europe/Zagreb" }, async () => {
  const target = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const targetTime = `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`;
  const dan  = String(target.getDate()).padStart(2, "0");
  const mjes = String(target.getMonth() + 1).padStart(2, "0");
  const god  = target.getFullYear();

  const exactPat = `${dan}.${mjes}.${god}. u ${targetTime}`;

  const { rows } = await pool.query(
    "SELECT * FROM requests WHERE status = 'potvrdjeno' AND date = $1",
    [exactPat]
  );

  if (rows.length === 0) return;
  console.log(`[REMINDER 2h] ${exactPat} — ${rows.length} termina`);

  for (const t of rows) {
    const client = loadClient(t.clientid);
    if (!client) continue;
    try {
      await sendPatientMail(client, {
        to:      t.email,
        subject: `Podsjetnik — termin za 2 sata — ${client.brandName}`,
        text:
          `Poštovani ${t.name},\n\n` +
          `Podsjećamo vas da imate termin za 2 sata.\n\n` +
          `Datum i vrijeme: ${t.date}\n` +
          `Usluga: ${t.service}\n\n` +
          (t.doctorid && client.doctors?.find(d => d.id === t.doctorid)
            ? `Doktor: ${client.doctors.find(d => d.id === t.doctorid).name}\n\n`
            : "") +
          `Do viđenja,\n${client.brandName}`,
      });
      console.log(`[REMINDER 2h] Poslan → ${t.email}`);
    } catch (err) {
      console.error(`[REMINDER 2h] Greška za ${t.email}:`, err.message);
    }
  }
});

// ── Mjesečno brisanje starih zapisa (GDPR retencija — 24 mjeseca) ──
cron.schedule("0 3 1 * *", { timezone: "Europe/Zagreb" }, async () => {
  const granica = new Date();
  granica.setMonth(granica.getMonth() - 24);
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM requests WHERE id < $1",
      [granica.getTime()]
    );
    console.log(`[RETENCIJA] Obrisano ${rowCount} zapisa starijih od 24 mjeseca.`);
  } catch (err) {
    console.error("[RETENCIJA] Greška:", err.message);
  }
});
