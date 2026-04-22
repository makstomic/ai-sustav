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

  console.log("[DB] PostgreSQL tablice inicijalizirane.");
}

module.exports = { pool, initDb };
