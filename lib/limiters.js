const rateLimit = require("express-rate-limit");

const faqLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { reply: "Previše zahtjeva. Pričekajte minutu i pokušajte opet." },
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { ok: false, error: "Previše zahtjeva. Pokušajte za sat vremena." },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { ok: false, error: "Previše zahtjeva." },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Previše zahtjeva." },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: "Previše neuspjelih pokušaja. Pokušajte za 15 minuta." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

module.exports = { faqLimiter, bookingLimiter, adminLimiter, publicLimiter, loginLimiter };
