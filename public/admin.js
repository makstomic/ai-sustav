const dijelovi = window.location.pathname.split("/");
const clientId = dijelovi[2];
const adminToken = dijelovi[3];
const wrap = document.getElementById("zahtjevi");
const title = document.getElementById("adminTitle");

let sviZahtjevi = [];
let aktivniTab = "cekanje";
let kalendarData = {};
let kalendarGodina = null;
let kalendarMjesec = null;
let odabraniDanKey = null;

const MJES_NAZIVI = ["Siječanj","Veljača","Ožujak","Travanj","Svibanj","Lipanj",
                     "Srpanj","Kolovoz","Rujan","Listopad","Studeni","Prosinac"];

// ── Tabovi ──
function napraviTabove() {
  const tabWrap = document.createElement("div");
  tabWrap.style.cssText = "display:flex; gap:8px; max-width:900px; margin:0 auto 20px; padding:0 16px;";
  tabWrap.innerHTML = `
    <button id="tab-cekanje"  onclick="promijeniTab('cekanje')"  style="flex:1; padding:11px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; border:1.5px solid var(--accent); background:var(--accent); color:#fff; font-family:var(--font);">Na čekanju</button>
    <button id="tab-povijest" onclick="promijeniTab('povijest')" style="flex:1; padding:11px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; border:1.5px solid var(--accent); background:transparent; color:var(--accent); font-family:var(--font);">Povijest</button>
    <button id="tab-kalendar" onclick="promijeniTab('kalendar')" style="flex:1; padding:11px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; border:1.5px solid var(--accent); background:transparent; color:var(--accent); font-family:var(--font);">Kalendar</button>
  `;
  document.getElementById("adminTitle").after(tabWrap);
}

function promijeniTab(tab) {
  aktivniTab = tab;
  ["cekanje", "povijest", "kalendar"].forEach(t => {
    const b = document.getElementById(`tab-${t}`);
    b.style.background = t === tab ? "var(--accent)" : "transparent";
    b.style.color      = t === tab ? "#fff"          : "var(--accent)";
  });

  if (tab === "kalendar") {
    ucitajKalendar();
  } else {
    prikaziZahtjeve();
  }
}

// ── HTML escaping — sprječava XSS ──
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Prikaz zahtjeva ──
function prikaziZahtjeve() {
  const filtrirani = sviZahtjevi.filter(z =>
    aktivniTab === "cekanje"
      ? z.status === "na_cekanju"
      : z.status !== "na_cekanju"
  );

  if (filtrirani.length === 0) {
    wrap.innerHTML = `<p class="prazno">${aktivniTab === "cekanje" ? "Nema zahtjeva na čekanju." : "Nema završenih zahtjeva."}</p>`;
    return;
  }

  wrap.innerHTML = filtrirani.map(z => `
    <div class="zahtjev-card" style="${z.status !== 'na_cekanju' ? 'opacity:0.65;' : ''}">
      <div class="zahtjev-header">
        <span class="zahtjev-ime">${esc(z.name)}</span>
        <div style="display:flex; align-items:center; gap:12px;">
          ${z.status === 'potvrdjeno' ? `<span class="status-badge status-potvrdjeno">Potvrđeno</span>` : ''}
          ${z.status === 'predlozeno' ? `<span class="status-badge status-predlozeno">Predloženo</span>` : ''}
          <span class="zahtjev-datum">${esc(z.primljeno)}</span>
        </div>
      </div>
      <div class="zahtjev-row"><span class="zahtjev-label">Email</span><span class="zahtjev-value">${esc(z.email)}</span></div>
      <div class="zahtjev-row"><span class="zahtjev-label">Datum</span><span class="zahtjev-value">${esc(z.date)}</span></div>
      <div class="zahtjev-row"><span class="zahtjev-label">Usluga</span><span class="zahtjev-value">${esc(z.service)}</span></div>
      <div class="zahtjev-row"><span class="zahtjev-label">Napomena</span><span class="zahtjev-value">${esc(z.note)}</span></div>
      ${z.status === 'na_cekanju' ? `
        <div class="zahtjev-akcije">
          <button class="btn-potvrdi" onclick="potvrdi(${esc(z.id)})">Potvrdi termin</button>
          <button class="btn-predlozi" onclick="predlozi(${esc(z.id)})">Predloži drugi termin</button>
        </div>
      ` : ''}
    </div>
  `).join("");
}

// ── Akcije ──
async function potvrdi(id) {
  const termin = prompt("Upiši potvrđeni termin (npr. 15.03. u 10:00):");
  if (!termin) return;

  await fetch("/admin-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, id, akcija: "potvrdi", termin }),
  });

  alert("Potvrda poslana pacijentu!");
  ucitajZahtjeve();
}

async function predlozi(id) {
  const termin = prompt("Upiši prijedlog termina (npr. 16.03. u 14:00):");
  if (!termin) return;

  await fetch("/admin-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, id, akcija: "predlozi", termin }),
  });

  alert("Prijedlog poslan pacijentu!");
  ucitajZahtjeve();
}

// ── Init zahtjevi ──
async function ucitajZahtjeve() {
  const [dataRes, configRes] = await Promise.all([
    fetch(`/admin-data/${clientId}?token=${adminToken}`),
    fetch(`/config/${clientId}`),
  ]);
  const data   = await dataRes.json();
  const config = await configRes.json();

  title.textContent = `Admin — ${data.brandName}`;
  sviZahtjevi = data.zahtjevi;

  if (config.theme?.accent) {
    document.documentElement.style.setProperty("--accent", config.theme.accent);
    document.documentElement.style.setProperty("--accent-2", config.theme.accent2 || config.theme.accent);
    document.documentElement.style.setProperty("--accent-soft", config.theme.accentSoft || "rgba(0,0,0,0.08)");
  }

  prikaziZahtjeve();
}

// ── Kalendar ──
async function ucitajKalendar() {
  try {
    const res = await fetch(`/admin-kalendar/${clientId}/${adminToken}`);
    kalendarData = await res.json();
  } catch {
    kalendarData = {};
  }
  const danas = new Date();
  if (kalendarGodina === null) kalendarGodina = danas.getFullYear();
  if (kalendarMjesec === null) kalendarMjesec  = danas.getMonth();
  prikaziKalendar();
}

function isoKey(date) {
  const g = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${g}-${m}-${d}`;
}

function mijenjajMjesec(smjer) {
  kalendarMjesec += smjer;
  if (kalendarMjesec > 11) { kalendarMjesec = 0; kalendarGodina++; }
  if (kalendarMjesec < 0)  { kalendarMjesec = 11; kalendarGodina--; }
  prikaziKalendar();
}

function odaberiDan(key) {
  odabraniDanKey = odabraniDanKey === key ? null : key;
  prikaziKalendar();
}

function prikaziKalendar() {
  const prviDan   = new Date(kalendarGodina, kalendarMjesec, 1);
  const zadnjiDan = new Date(kalendarGodina, kalendarMjesec + 1, 0);
  const danasKey  = isoKey(new Date());

  // Offset: koliko praznih ćelija ispred (tjedan počinje ponedjeljkom)
  let pocetakOffset = prviDan.getDay() - 1;
  if (pocetakOffset < 0) pocetakOffset = 6;

  const daniTjedna = ["Po", "Ut", "Sr", "Če", "Pe", "Su", "Ne"];

  const headerHTML = daniTjedna.map(d =>
    `<div class="kal-header-dan">${d}</div>`
  ).join("");

  const prazneHTML = Array(pocetakOffset)
    .fill('<div class="kal-dan kal-prazan"></div>')
    .join("");

  let daniHTML = "";
  for (let d = 1; d <= zadnjiDan.getDate(); d++) {
    const key = isoKey(new Date(kalendarGodina, kalendarMjesec, d));
    const imaTermina = !!kalendarData[key];
    const jeOdabran  = key === odabraniDanKey;
    const jeDanas    = key === danasKey;

    let klase = "kal-dan";
    if (jeOdabran)            klase += " kal-odabran";
    if (jeDanas && !jeOdabran) klase += " kal-danas";

    daniHTML += `
      <div class="${klase}" onclick="odaberiDan('${key}')">
        ${d}
        ${imaTermina ? '<span class="kal-dot"></span>' : ''}
      </div>`;
  }

  const terminiHTML = odabraniDanKey ? napraviTermine(odabraniDanKey) : "";
  const naslov = `${MJES_NAZIVI[kalendarMjesec]} ${kalendarGodina}`;

  wrap.innerHTML = `
    <div class="kal-wrap">
      <div class="kal-nav">
        <button class="kal-nav-btn" onclick="mijenjajMjesec(-1)">&#8592;</button>
        <span class="kal-mjes">${esc(naslov)}</span>
        <button class="kal-nav-btn" onclick="mijenjajMjesec(1)">&#8594;</button>
      </div>
      <div class="kal-card">
        <div class="kal-grid">
          ${headerHTML}
          ${prazneHTML}
          ${daniHTML}
        </div>
      </div>
      ${terminiHTML}
    </div>
  `;
}

function napraviTermine(dateKey) {
  const zauzetiTermini = kalendarData[dateKey] || [];
  const zauzetoMap = {};
  for (const t of zauzetiTermini) {
    zauzetoMap[t.time] = t;
  }

  // Slotovi 09:00 — 16:30 svakih 30 min
  const slotovi = [];
  for (let h = 9; h <= 16; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 16 && m > 30) break;
      slotovi.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }

  const [g, mj, d] = dateKey.split("-");
  const hrDatum = `${parseInt(d)}. ${parseInt(mj)}. ${g}.`;

  const slotsHTML = slotovi.map(s => {
    const termin = zauzetoMap[s];
    if (termin) {
      return `
        <div class="termin-slot zauzet">
          ${esc(s)}
          <span class="termin-info">${esc(termin.name)} — ${esc(termin.service)}</span>
        </div>`;
    }
    return `<div class="termin-slot">${esc(s)}</div>`;
  }).join("");

  return `
    <div class="termini-wrap">
      <div class="termini-naslov">Termini — ${esc(hrDatum)}</div>
      <div class="termini-grid">${slotsHTML}</div>
    </div>`;
}

napraviTabove();
ucitajZahtjeve();
