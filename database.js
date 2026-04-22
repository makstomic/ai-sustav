const Database = require("better-sqlite3");
const path     = require("path");

const dbPath = process.env.DB_PATH || path.join(__dirname, "requests.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id        INTEGER PRIMARY KEY,
    clientId  TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    email     TEXT    NOT NULL,
    date      TEXT    NOT NULL,
    service   TEXT    NOT NULL,
    note      TEXT    NOT NULL DEFAULT '—',
    status    TEXT    NOT NULL DEFAULT 'na_cekanju',
    primljeno TEXT    NOT NULL
  )
`);

// Migracija — dodaj doctorId stupac ako ne postoji
try {
  db.exec("ALTER TABLE requests ADD COLUMN doctorId TEXT NOT NULL DEFAULT ''");
} catch (_) { /* stupac već postoji */ }

// Index za brže upite po clientId
db.exec("CREATE INDEX IF NOT EXISTS idx_clientId ON requests(clientId)");

// Tjedno radno vrijeme po doktoru
db.exec(`
  CREATE TABLE IF NOT EXISTS doctor_schedules (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId  TEXT    NOT NULL,
    doctorId  TEXT    NOT NULL,
    dayOfWeek INTEGER NOT NULL,
    startTime TEXT    NOT NULL,
    endTime   TEXT    NOT NULL,
    UNIQUE(clientId, doctorId, dayOfWeek)
  )
`);

// Iznimke — blokada dana ili pojedinog slota
db.exec(`
  CREATE TABLE IF NOT EXISTS schedule_exceptions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId TEXT NOT NULL,
    doctorId TEXT NOT NULL,
    date     TEXT NOT NULL,
    type     TEXT NOT NULL,
    time     TEXT,
    note     TEXT NOT NULL DEFAULT ''
  )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_exceptions ON schedule_exceptions(clientId, doctorId, date)");

module.exports = db;
