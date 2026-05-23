require("dotenv").config();
const express      = require("express");
const path         = require("path");
const cookieParser = require("cookie-parser");
const morgan       = require("morgan");
const helmet       = require("helmet");

const { initDb }   = require("./database");
const { logError } = require("./lib/errorLog");

const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(morgan("dev"));

// ── Security headers ─────────────────────────────────────────────────────────
//
// Helmet mora ići PRIJE express.static da headeri stignu i na statičke fajlove.
//
// CSP: unsafe-inline je PRIVREMENO — admin.html, booking.html i login.html
// koriste inline onclick atribute i <script> tagove direktno u HTML-u.
// Kad se to refaktorira u vanjske .js fajlove, unsafe-inline se može maknuti
// i zamijeniti s nonce-based CSP za puno bolju zaštitu.

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // PRIVREMENO unsafe-inline: inline <script> blokovi u HTML-u
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:"],
      connectSrc:     ["'self'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
    },
  },
  referrerPolicy:            { policy: "strict-origin-when-cross-origin" },
  crossOriginEmbedderPolicy: false,
}));

// Permissions-Policy — helmet ne postavlja ovo automatski
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Cache-Control: no-store za admin stranice i API — browser ne smije cachirati
// admin HTML ni API odgovore koji sadrže podatke klinika
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith("/admin") || p === "/login" || p.startsWith("/admin-")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// ── Ostali middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());
app.use(express.static("public"));

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "booking.html"));
});

app.use("/", require("./routes/booking"));
app.use("/", require("./routes/admin"));
app.use("/", require("./routes/gdpr"));

require("./jobs/cron");

// Global Express error handler — hvata sve neuhvaćene greške iz routeova
app.use((err, req, res, next) => {
  logError(`${req.method} ${req.path}`, err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "Interna greška servera." });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server radi na http://localhost:${PORT}/admin`);
    });
  })
  .catch(err => {
    logError("DB init", err);
    process.exit(1);
  });
