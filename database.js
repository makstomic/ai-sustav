const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id        BIGINT PRIMARY KEY,
      clientId  TEXT   NOT NULL,
      name      TEXT   NOT NULL,
      email     TEXT   NOT NULL,
      date      TEXT   NOT NULL,
      service   TEXT   NOT NULL,
      note      TEXT   NOT NULL DEFAULT '—',
      status    TEXT   NOT NULL DEFAULT 'na_cekanju',
      primljeno TEXT   NOT NULL,
      doctorId  TEXT   NOT NULL DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_clientId ON requests(clientId)
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
      token     TEXT        PRIMARY KEY,
      clientid  TEXT        NOT NULL,
      createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expiresat TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_clientid ON sessions(clientid)
  `);

  console.log("[DB] PostgreSQL tablice inicijalizirane.");
}

module.exports = { pool, initDb };
