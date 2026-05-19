const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id               BIGINT      PRIMARY KEY,
      clientId         TEXT        NOT NULL,
      name             TEXT        NOT NULL,
      email            TEXT        NOT NULL,
      date             TEXT        NOT NULL,
      service          TEXT        NOT NULL,
      note             TEXT        NOT NULL DEFAULT '—',
      status           TEXT        NOT NULL DEFAULT 'na_cekanju',
      primljeno        TEXT        NOT NULL,
      doctorId         TEXT        NOT NULL DEFAULT '',
      appointmentAt    TIMESTAMPTZ,
      createdAt        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reminder1dSentAt TIMESTAMPTZ,
      reminder2hSentAt TIMESTAMPTZ
    )
  `);

  // Dodaj nove stupce za postojeće baze (idempotentno)
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS appointmentAt    TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS createdAt        TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS reminder1dSentAt TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS reminder2hSentAt TIMESTAMPTZ`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientId ON requests(clientId)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_requests_appointment ON requests(clientid, doctorid, appointmentat)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_requests_createdat ON requests(createdat)`);

  // Parcijalni indeksi — samo redovi koji još trebaju reminder (mali, brzi)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_1d
    ON requests(appointmentat)
    WHERE status = 'potvrdjeno' AND reminder1dsentat IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_2h
    ON requests(appointmentat)
    WHERE status = 'potvrdjeno' AND reminder2hsentat IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS doctor_schedules (
      id        SERIAL PRIMARY KEY,
      clientId  TEXT    NOT NULL,
      doctorId  TEXT    NOT NULL,
      dayOfWeek INTEGER NOT NULL,
      startTime TEXT    NOT NULL,
      endTime   TEXT    NOT NULL,
      UNIQUE(clientId, doctorId, dayOfWeek)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_exceptions (
      id       SERIAL PRIMARY KEY,
      clientId TEXT NOT NULL,
      doctorId TEXT NOT NULL,
      date     TEXT NOT NULL,
      type     TEXT NOT NULL,
      time     TEXT,
      note     TEXT NOT NULL DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exceptions ON schedule_exceptions(clientId, doctorId, date)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinic_doctors (
      id           SERIAL PRIMARY KEY,
      clientId     TEXT   NOT NULL,
      doctorId     TEXT   NOT NULL,
      name         TEXT   NOT NULL,
      displayOrder INT    NOT NULL DEFAULT 0,
      UNIQUE(clientId, doctorId)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinic_services (
      id           SERIAL PRIMARY KEY,
      clientId     TEXT   NOT NULL,
      name         TEXT   NOT NULL,
      duration     INT    NOT NULL DEFAULT 30,
      displayOrder INT    NOT NULL DEFAULT 0,
      UNIQUE(clientId, name)
    )
  `);

  // Sprječava dva potvrđena termina za isti slot
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_confirmed_slot
    ON requests(clientid, doctorid, date)
    WHERE status = 'potvrdjeno'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT        PRIMARY KEY,
      clientid   TEXT        NOT NULL,
      csrftoken  TEXT        NOT NULL DEFAULT '',
      createdat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expiresat  TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrftoken TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_clientid ON sessions(clientid)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id        SERIAL      PRIMARY KEY,
      clientid  TEXT        NOT NULL,
      action    TEXT        NOT NULL,
      requestid BIGINT,
      detail    TEXT        NOT NULL DEFAULT '',
      createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_clientid ON audit_log(clientid, createdat DESC)
  `);

  console.log("[DB] PostgreSQL tablice inicijalizirane.");
}

module.exports = { pool, initDb };
