// Učitamo clientId iz URL-a: /booking/simic
const clientId = window.location.pathname.split("/").pop();

const form          = document.getElementById("bookingForm");
const bookingStatus = document.getElementById("bookingStatus");
const chatMessages  = document.getElementById("chatMessages");
const chatInput     = document.getElementById("chatInput");
const chatSend      = document.getElementById("chatSend");

let history      = [];
let clientConfig = null;

// Doktori
let sviDoktori    = [];
let aktivniDrIdx  = 0;

function aktivniDoktorId() {
  return sviDoktori[aktivniDrIdx]?.id || "";
}

window.aktivniDoktorIme = function() {
  return sviDoktori[aktivniDrIdx]?.name || "";
};

function promijeniDoktora(smjer) {
  if (sviDoktori.length === 0) return;
  aktivniDrIdx = (aktivniDrIdx + smjer + sviDoktori.length) % sviDoktori.length;
  document.getElementById("doctorIme").textContent = sviDoktori[aktivniDrIdx]?.name || "—";
  if (typeof window._resetKalendar === "function") window._resetKalendar();
  if (typeof window._resetDoctorConfirm === "function") window._resetDoctorConfirm();
}

function initDoctorSwitcher(doctors) {
  sviDoktori = doctors || [];
  if (sviDoktori.length === 0) return;

  const sw = document.getElementById("doctorSwitcher");
  if (sw) sw.style.display = "flex";
  const imeEl = document.getElementById("doctorIme");
  if (imeEl) imeEl.textContent = sviDoktori[0]?.name || "—";

  const confirmSection = document.getElementById("doctorConfirmSection");
  const confirmBtn = document.getElementById("doctorConfirmBtn");
  if (confirmSection) confirmSection.style.display = "block";
  if (!confirmBtn) return;

  function setConfirmed(confirmed) {
    if (confirmed) {
      const name = sviDoktori[aktivniDrIdx]?.name || "Doktor";
      // DOM API umjesto innerHTML — ime doktora je admin-controlled string, može sadržavati <> znakove
      confirmBtn.textContent = "";
      const tickSpan = document.createElement("span");
      tickSpan.textContent = `✓ ${name}`;
      const resetSpan = document.createElement("span");
      resetSpan.className = "dr-reset-x";
      resetSpan.id = "drResetX";
      resetSpan.textContent = "✕";
      confirmBtn.appendChild(tickSpan);
      confirmBtn.appendChild(resetSpan);
      confirmBtn.classList.add("potvrden");
      document.getElementById("drResetX").addEventListener("click", (e) => {
        e.stopPropagation();
        setConfirmed(false);
      });
    } else {
      confirmBtn.textContent = "Potvrdi odabir doktora";
      confirmBtn.classList.remove("potvrden");
    }
  }

  confirmBtn.addEventListener("click", () => {
    if (confirmBtn.classList.contains("potvrden")) return;
    setConfirmed(true);
    if (window._isMobile && window._isMobile()) {
      window.idiNaKorak(2);
    } else {
      document.querySelector(".kalendar")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  // Reset potvrde kad se promijeni doktor strelicom
  window._resetDoctorConfirm = () => setConfirmed(false);
}

// ── Chat bubble helpers ──
function addMsg(text, tko) {
  const row = document.createElement("div");
  row.className = `row ${tko}`;

  const msg = document.createElement("div");
  msg.className = `msg ${tko}`;
  msg.textContent = text;

  row.appendChild(msg);
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

const addBot  = (text) => addMsg(text, "bot");
const addUser = (text) => addMsg(text, "user");

// ── Učitaj config klijenta ──
async function loadConfig() {
  const res = await fetch(`/config/${clientId}`);
  if (!res.ok) throw new Error("Ne mogu učitati config.");
  clientConfig = await res.json();


  const t = clientConfig.theme || {};
  if (t.accent) {
    document.documentElement.style.setProperty("--accent", t.accent);
    document.documentElement.style.setProperty("--accent-2", t.accent2 || t.accent);
    document.documentElement.style.setProperty("--accent-soft", t.accentSoft || "rgba(45,74,138,0.10)");
  }
  if (t.bgColor) {
    document.documentElement.style.setProperty("--bg", t.bgColor);
  }
  if (t.bgSoft) {
    document.documentElement.style.setProperty("--bg-soft", t.bgSoft);
  }

  // Font
  if (clientConfig.font) {
    const fontName = clientConfig.font;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@400;500;600;700;800&display=swap`;
    document.head.appendChild(link);
    document.documentElement.style.setProperty("--font", `'${fontName}', ui-sans-serif, system-ui, sans-serif`);
  }

  // Kontakt box
  if (clientConfig.location) {
    document.getElementById("kontakt-lokacija-tekst").textContent = clientConfig.location;
    document.getElementById("kontakt-lokacija").style.display = "flex";
  }
  if (clientConfig.phone) {
    document.getElementById("kontakt-telefon-tekst").textContent = clientConfig.phone;
    document.getElementById("kontakt-telefon").style.display = "flex";
  }
  if (clientConfig.workingHours) {
    document.getElementById("kontakt-sati-tekst").textContent = clientConfig.workingHours;
    document.getElementById("kontakt-sati").style.display = "flex";
  }


  // Page naslov
  const pageTitleEl = document.querySelector('.page-title');
  if (pageTitleEl) pageTitleEl.textContent = clientConfig.pageTitle || clientConfig.brandName || 'Rezervacija termina';
  document.title = `Rezervacija — ${clientConfig.brandName || 'Ordinacija'}`;

  // Chat header
  document.getElementById("chatHeaderTitle").textContent = `${clientConfig.brandName} — Asistent`;
}

// ── FAQ chatbot ──
async function askFAQ(message) {
  const res = await fetch("/faq", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, message, history }),
  });

  if (!res.ok) throw new Error("FAQ greška");
  const data = await res.json();
  return data.reply;
}

// ── Booking forma ──
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!window.eUslugaOdabrana()) {
    bookingStatus.textContent = "Odaberite uslugu prije slanja zahtjeva.";
    document.getElementById("uslugaSekcija")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  bookingStatus.textContent = "Šaljem...";

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  const phoneVal = document.getElementById("phone")?.value.trim() || "";
  const noteVal  = document.getElementById("note").value.trim();
  const payload = {
    clientId,
    doctorId: aktivniDoktorId(),
    name:    document.getElementById("name").value.trim(),
    email:   document.getElementById("email").value.trim(),
    date:    document.getElementById("date").value.trim(),
    service: document.getElementById("service").value.trim(),
    note:    [phoneVal ? `Tel: ${phoneVal}` : "", noteVal].filter(Boolean).join(" | "),
    _hp:     document.getElementById("_hp")?.value || "",
    // TODO Cloudflare Turnstile: ovdje dodati cfTurnstileToken iz widgeta
  };

  try {
    const res  = await fetch("/booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.ok) {
      bookingStatus.textContent =
        "Zaprimili smo zahtjev. Ordinacija će se javiti mailom s potvrdom ili alternativom. Vaši podaci obrađuju se sukladno Privacy Policy.";
      form.reset();
    } else {
      bookingStatus.textContent = data.error || "Greška pri slanju. Pokušaj opet.";
    }
  } catch {
    bookingStatus.textContent = "Greška pri slanju. Pokušaj opet.";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

// ── Chat ──
async function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;

  addUser(msg);
  chatInput.value = "";
  history.push({ role: "user", content: msg });

  try {
    const reply = await askFAQ(msg);
    addBot(reply);
    history.push({ role: "assistant", content: reply });
  } catch {
    addBot("Greška pri dohvatu odgovora. Pokušaj opet.");
  }
}

chatSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

// ── Quick reply gumbi ──
function addQuickReplies() {
  const opcije = [
    {
      label: "Želim zakazati termin",
      async onKlik() {
        const odgovor = "Odlično! Ispunite formu s lijeve strane — odaberite datum, unesite ime, email i uslugu. Ordinacija će vam se javiti mailom s potvrdom termina.";
        addBot(odgovor);
        history.push({ role: "assistant", content: odgovor });
      },
    },
    {
      label: "Imam pitanje o ordinaciji",
      async onKlik() {
        const odgovor = "Naravno! Što vas zanima? Mogu pomoći s informacijama o uslugama, cijenama, radnom vremenu i lokaciji.";
        addBot(odgovor);
        history.push({ role: "assistant", content: odgovor });
      },
    },
  ];

  const wrap = document.createElement("div");
  wrap.id = "quickReplies";
  wrap.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  `;

  opcije.forEach(({ label, onKlik }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `
      padding: 8px 14px;
      border: 1.5px solid var(--accent);
      border-radius: 999px;
      background: transparent;
      color: var(--accent);
      font-family: var(--font);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    `;
    btn.onmouseover = () => {
      btn.style.background = "var(--accent)";
      btn.style.color = "#fff";
    };
    btn.onmouseout = () => {
      btn.style.background = "transparent";
      btn.style.color = "var(--accent)";
    };
    btn.addEventListener("click", async () => {
      document.getElementById("quickReplies")?.remove();
      addUser(label);
      history.push({ role: "user", content: label });
      await onKlik();
    });
    wrap.appendChild(btn);
  });

  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Odabir usluge ──
window.eUslugaOdabrana = function() {
  return !!(document.getElementById("service")?.value);
};

window.odaberiUslugu = function(name) {
  const inp = document.getElementById("service");
  if (inp) inp.value = name;
  document.querySelectorAll(".usluga-chip").forEach(c =>
    c.classList.toggle("aktivan", c.dataset.name === name)
  );
  const chip = document.querySelector(`.usluga-chip[data-name="${name.replace(/"/g, '\\"')}"]`);
  const dur = parseInt(chip?.dataset.duration || 30, 10);
  if (window._setDuracija) window._setDuracija(dur);
  document.getElementById("kalUpozorenje").style.display = "none";
  if (window._isMobile && window._isMobile()) window.idiNaKorak(3);
};

// ── Popuni usluge iz configa ──
function populateServices() {
  const services = clientConfig.services || [];
  const chipsEl  = document.getElementById("uslugaChips");
  if (!chipsEl) return;

  services.forEach(({ name, duration }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "usluga-chip";
    btn.textContent = name;
    btn.dataset.name = name;
    btn.dataset.duration = duration || 30;
    btn.addEventListener("click", () => window.odaberiUslugu(name));
    chipsEl.appendChild(btn);
  });

  if (services.length > 0) {
    const sekcija = document.getElementById("uslugaSekcija");
    if (sekcija) sekcija.style.display = "";
  }
}

// INIT
(async () => {
  try {
    await loadConfig();
    populateServices();
    initDoctorSwitcher(clientConfig.doctors || []);

    // Učitaj rasporede doktora iz baze (ako postoje)
    let drSchedules = {};
    if ((clientConfig.doctors || []).length > 0) {
      try {
        const r = await fetch(`/doctor-schedule/${clientId}`);
        if (r.ok) drSchedules = await r.json();
      } catch { /* koristi clinic default */ }
    }

    if (typeof window.initKalendar === 'function') window.initKalendar({}, drSchedules);

    // Postavi inicijalni korak na mobilnom
    if (window._isMobile && window._isMobile() && window.idiNaKorak) {
      const hasDoctors  = (clientConfig.doctors  || []).length > 0;
      const hasServices = (clientConfig.services || []).length > 0;
      window.idiNaKorak(hasDoctors ? 1 : hasServices ? 2 : 3);
    }

    const pozdrav = `Dobrodošli u ${clientConfig.brandName}! 👋\n\nJa sam vaš digitalni asistent. Mogu vam pomoći s informacijama o uslugama, cijenama i ordinaciji.\n\nO čemu želite saznati više?`;

    addBot(pozdrav);
    history.push({ role: "assistant", content: pozdrav });

    addQuickReplies();

  } catch (err) {
    console.error(err);
    addBot("Ne mogu učitati ordinaciju. Provjeri clientId.");
  }
})();
