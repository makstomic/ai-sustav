// Učitamo clientId iz URL-a: /booking/simic
const clientId = window.location.pathname.split("/").pop();

const pageTitle     = document.getElementById("pageTitle");
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
  // Reset kalendara za novog doktora
  if (typeof window._resetKalendar === "function") window._resetKalendar();
}

function initDoctorSwitcher(doctors) {
  sviDoktori = doctors || [];
  if (sviDoktori.length === 0) return;
  const sw = document.getElementById("doctorSwitcher");
  if (sw) sw.style.display = "flex";
  const imeEl = document.getElementById("doctorIme");
  if (imeEl) imeEl.textContent = sviDoktori[0]?.name || "—";
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

  pageTitle.innerText = `Rezervacija — ${clientConfig.brandName}`;

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
  bookingStatus.textContent = "Šaljem...";

  const payload = {
    clientId,
    doctorId: aktivniDoktorId(),
    name:    document.getElementById("name").value.trim(),
    email:   document.getElementById("email").value.trim(),
    date:    document.getElementById("date").value.trim(),
    service: document.getElementById("service").value.trim(),
    note:    document.getElementById("note").value.trim(),
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
        "Zaprimili smo zahtjev. Ordinacija će se javiti mailom s potvrdom ili alternativom.";
      form.reset();
    } else {
      bookingStatus.textContent = "Greška pri slanju. Pokušaj opet.";
    }
  } catch {
    bookingStatus.textContent = "Greška pri slanju. Pokušaj opet.";
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

// ── Popuni usluge iz configa ──
function populateServices() {
  const select = document.getElementById("service");
  const services = clientConfig.services || [];
  if (!services.length) return;

  select.innerHTML = '<option value="" disabled selected>Odaberite uslugu</option>';
  services.forEach(({ name }) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

// INIT
(async () => {
  try {
    await loadConfig();
    populateServices();
    initDoctorSwitcher(clientConfig.doctors || []);
    if (typeof window.initKalendar === 'function') window.initKalendar(clientConfig.workingHoursSchedule || {});

    const pozdrav = `Dobrodošli u ${clientConfig.brandName}! 👋\n\nJa sam vaš digitalni asistent. Mogu vam pomoći s informacijama o uslugama, cijenama i ordinaciji.\n\nO čemu želite saznati više?`;

    addBot(pozdrav);
    history.push({ role: "assistant", content: pozdrav });

    addQuickReplies();

  } catch (err) {
    console.error(err);
    addBot("Ne mogu učitati ordinaciju. Provjeri clientId.");
  }
})();
