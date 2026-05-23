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

  // ── CHECK constraints (idempotentno: duplicate_object → NULL) ────────────────

  // requests.status — jedine dopuštene vrijednosti
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE requests ADD CONSTRAINT chk_requests_status
        CHECK (status IN ('na_cekanju','potvrdjeno','predlozeno','odbijeno','otkazano'))
        NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // requests — length limiti usklađeni s app-level validacijom
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE requests ADD CONSTRAINT chk_requests_name_len
        CHECK (char_length(name) <= 100) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE requests ADD CONSTRAINT chk_requests_email_len
        CHECK (char_length(email) <= 254) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE requests ADD CONSTRAINT chk_requests_date_len
        CHECK (char_length(date) <= 50) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE requests ADD CONSTRAINT chk_requests_service_len
        CHECK (char_length(service) <= 100) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE requests ADD CONSTRAINT chk_requests_note_len
        CHECK (char_length(note) <= 500) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // clinic_services.duration — pozitivan i razuman maksimum
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE clinic_services ADD CONSTRAINT chk_services_duration
        CHECK (duration > 0 AND duration <= 240) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE clinic_services ADD CONSTRAINT chk_services_name_len
        CHECK (char_length(name) <= 200) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // doctor_schedules.dayofweek — 0–6 (tjedan A) ili 10–16 (tjedan B za alternativni raspored)
  await pool.query(`ALTER TABLE doctor_schedules DROP CONSTRAINT IF EXISTS chk_schedules_dayofweek`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE doctor_schedules ADD CONSTRAINT chk_schedules_dayofweek
        CHECK ((dayofweek >= 0 AND dayofweek <= 6) OR (dayofweek >= 10 AND dayofweek <= 16)) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // schedule_exceptions.type — samo poznate vrijednosti
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE schedule_exceptions ADD CONSTRAINT chk_exceptions_type
        CHECK (type IN ('block_day','block_slot')) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE schedule_exceptions ADD CONSTRAINT chk_exceptions_note_len
        CHECK (char_length(note) <= 200) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // clinic_doctors.name
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE clinic_doctors ADD CONSTRAINT chk_doctors_name_len
        CHECK (char_length(name) <= 200) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // ── Dodatni indeks: (clientid, status) za česte admin queryje ─────────────
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_requests_clientid_status
    ON requests(clientid, status)
  `);

  // ── Unique confirmed slot: s date teksta na appointmentat TIMESTAMPTZ ────────
  //
  // Stari indeks bio je na (clientid, doctorid, date TEXT) — nije mogao koristiti
  // TIMESTAMPTZ za točnu usporedbu i nije pokrivao phone_booking bez appointmentat.
  // Novi indeks koristi appointmentat s WHERE IS NOT NULL da ne blokira legacyne
  // NULL retke. Phone_booking sada mora postavljati appointmentat (vidi admin.js).
  await pool.query(`DROP INDEX IF EXISTS idx_unique_confirmed_slot`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_confirmed_slot
    ON requests(clientid, doctorid, appointmentat)
    WHERE status = 'potvrdjeno' AND appointmentat IS NOT NULL
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

  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_clientid ON audit_log(clientid, createdat DESC)
  `);

  console.log("[DB] PostgreSQL tablice inicijalizirane.");
}

module.exports = { pool, initDb };
