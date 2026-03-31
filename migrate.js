require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const db   = require("./database");

const requestsDir = path.join(__dirname, "requests");

if (!fs.existsSync(requestsDir)) {
  console.log("Nema requests/ foldera, nema što migrirati.");
  process.exit(0);
}

const files = fs.readdirSync(requestsDir).filter(f => f.endsWith(".json"));

if (files.length === 0) {
  console.log("Nema JSON fajlova za migraciju.");
  process.exit(0);
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO requests (id, clientId, name, email, date, service, note, status, primljeno)
  VALUES (@id, @clientId, @name, @email, @date, @service, @note, @status, @primljeno)
`);

const migrateAll = db.transaction((entries) => {
  for (const entry of entries) insert.run(entry);
});

let ukupno = 0;

for (const file of files) {
  const clientId = path.basename(file, ".json");
  const raw      = fs.readFileSync(path.join(requestsDir, file), "utf-8");
  const data     = JSON.parse(raw);

  const entries = data.map(r => ({
    id:        r.id,
    clientId,
    name:      r.name,
    email:     r.email,
    date:      r.date,
    service:   r.service,
    note:      r.note  || "—",
    status:    r.status,
    primljeno: r.primljeno,
  }));

  migrateAll(entries);
  console.log(`Migrirano ${entries.length} zahtjeva za klijenta "${clientId}"`);
  ukupno += entries.length;
}

console.log(`\nUkupno migrirano: ${ukupno} zahtjeva.`);
