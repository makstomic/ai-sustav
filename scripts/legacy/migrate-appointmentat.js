require("dotenv").config();
const { pool }                          = require("./database");
const { parseCroatianDate, parsedToTimestamp } = require("./lib/utils");

async function run() {
  console.log("[MIGRATE] Spajanje na bazu...");

  const { rows } = await pool.query(
    "SELECT id, date FROM requests WHERE appointmentat IS NULL ORDER BY id"
  );

  if (rows.length === 0) {
    console.log("[MIGRATE] Nema zapisa za backfill — appointmentAt je već popunjen.");
    await pool.end();
    return;
  }

  console.log(`[MIGRATE] Pronađeno ${rows.length} zapisa bez appointmentAt...`);

  let migrated = 0;
  let warnings = 0;

  for (const row of rows) {
    const parsed = parseCroatianDate(row.date);

    if (!parsed) {
      console.warn(`[MIGRATE] ⚠️  Nije moguće parsirati: id=${row.id} | date="${row.date}"`);
      warnings++;
      continue;
    }

    const ts = parsedToTimestamp(parsed);

    await pool.query(
      "UPDATE requests SET appointmentat = $1 WHERE id = $2",
      [ts, row.id]
    );
    migrated++;
  }

  console.log(`\n[MIGRATE] Gotovo.`);
  console.log(`  ✓ Migrirano:   ${migrated}`);
  console.log(`  ⚠  Upozorenja: ${warnings} (zapisi ostavljeni NULL — mogu se ignorirati)`);

  await pool.end();
}

run().catch(err => {
  console.error("[MIGRATE] Greška:", err);
  process.exit(1);
});
