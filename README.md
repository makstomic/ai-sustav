# Ordinova

Multi-tenant medicinski booking SaaS. Svaka klinika ima vlastiti `clientId` i JSON konfiguraciju u `clients/`.

## Pokretanje lokalno

```bash
npm install
cp .env.example .env
# Popuni .env s pravim vrijednostima
node server.js
```

Server se pokreće na `http://localhost:3000`.

## Environment varijable

| Varijabla | Opis |
|-----------|------|
| `NODE_ENV` | `development` ili `production` |
| `DATABASE_URL` | PostgreSQL connection string |
| `OPENAI_API_KEY` | OpenAI ključ za FAQ chatbot |
| `RESEND_API_KEY` | Resend ključ za slanje mailova |
| `EMAIL_FROM` | Adresa pošiljatelja |
| `CLINIC_EMAIL` | Fallback email za obavijesti klinici |

## Baza podataka

Shema se automatski kreira pri pokretanju servera (`database.js → initDb()`). Nema potrebe za ručnim migracijama pri prvom pokretanju.

### Migracija appointmentat (jednokratno, već odradjeno)

Ako pokrećeš na bazi koja ima stare zapise bez `appointmentat` stupca:

```bash
npm run migrate
```

## Klijenti (klinike)

Svaka klinika je JSON fajl u `clients/<clientId>.json`. Obavezna polja:

- `brandName` — naziv klinike
- `adminPasswordHash` — bcrypt hash admin lozinke

Za hashiranje lozinke novog klijenta:

```bash
npm run hash-passwords
```

Skripta čita sve `clients/*.json`, hashira `adminToken` polje i sprema `adminPasswordHash`. Pokreni jednom po klijentu, commitaj JSON bez `adminToken`.

## Arhitektura

```
routes/booking.js   — javni booking API
routes/admin.js     — admin panel API (session + CSRF zaštita)
routes/gdpr.js      — GDPR endpoint (pretraga, export, brisanje)
lib/utils.js        — validacija, session, date parsing
lib/mail.js         — slanje mailova (Resend)
lib/limiters.js     — rate limiteri
lib/errorLog.js     — in-memory error log (max 200, resetira se na restart)
jobs/cron.js        — podsjetnici (1d i 2h prije termina), GDPR retencija
database.js         — PostgreSQL pool + schema init
clients/            — per-klijent JSON konfiguracije
```

## Security napomene

- Admin session cookie je `httpOnly`, `secure` (u produkciji), `sameSite: strict`
- Svaki admin POST zahtijeva CSRF token (`X-CSRF-Token` header)
- Rate limiteri: booking 5/h, login 5/15min, admin 60/min
- Honeypot polje na booking formi — tiho odbacuje botove
- CSP: `script-src unsafe-inline` je privremeno (inline skripte u HTML-u). Planiran refaktor na event delegation + nonce.
- `errorLog` je in-memory — greške se gube na restart servera. Za produkcijsko logiranje razmotriti Sentry ili DB tablicu.
- GDPR retencija: zapisi stariji od 24 mjeseca brišu se automatski 1. u mjesecu.
