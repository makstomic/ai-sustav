require("dotenv").config();
const express      = require("express");
const path         = require("path");
const cookieParser = require("cookie-parser");
const morgan       = require("morgan");

const { initDb }   = require("./database");
const { logError } = require("./lib/errorLog");

const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(morgan("dev"));
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());
app.use(express.static("public"));
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

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
