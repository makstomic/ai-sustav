const dijelovi = window.location.pathname.split("/");
const clientId = dijelovi[2];

// Podrška za stari URL format (/admin/clientId/token)
const tokenFromUrl = dijelovi[3];
if (tokenFromUrl) sessionStorage.setItem("adminToken_" + clientId, tokenFromUrl);

const adminToken = sessionStorage.getItem("adminToken_" + clientId);
if (!adminToken) {
  window.location.href = "/login/" + clientId;
}

const wrap = document.getElementById("zahtjevi");
const title = document.getElementById("adminTitle");

let sviZahtjevi = [];
let aktivniTab = "cekanje";
let kalendarData = {};
let kalendarGodina = null;
let kalendarMjesec = null;
let odabraniDanKey = null;
let workingHoursSchedule = {};

// Doktori
let sviDoktori = [];       // [{id, name}, ...]
let aktivniDoktorIdx = 0;  // index u sviDoktori

const MJES_NAZIVI = ["Siječanj","Veljača","Ožujak","Travanj","Svibanj","Lipanj",
                     "Srpanj","Kolovoz","Rujan","Listopad","Studeni","Prosinac"];

function generirajTermine(raspon) {
  if (!raspon) return [];
  const [od, do_] = raspon.split('-');
  const [odH, odM] = od.split(':').map(Number);
  const [doH, doM] = do_.split(':').map(Number);
  const termini = [];
  let h = odH, m = odM;
  while (h * 60 + m < doH * 60 + doM) {
    termini.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    m += 30;
    if (m >= 60) { m -= 60; h++; }
  }
  return termini;
}

// ── HTML escaping ──
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Doctor switcher HTML ──
function doktorSwitcherHTML() {
  if (sviDoktori.length === 0) return "";
  const ime = sviDoktori[aktivniDoktorIdx]?.name || "—";
  return `
    <div class="doctor-switcher">
      <span class="doctor-switcher-label">Doktor</span>
      <button class="doctor-arrow" onclick="promijeniDoktora(-1)">&#8592;</button>
      <span class="doctor-switcher-name">${esc(ime)}</span>
      <button class="doctor-arrow" onclick="promijeniDoktora(1)">&#8594;</button>
    </div>
  `;
}

function promijeniDoktora(smjer) {
  if (sviDoktori.length === 0) return;
  aktivniDoktorIdx = (aktivniDoktorIdx + smjer + sviDoktori.length) % sviDoktori.length;
  if (aktivniTab === "kalendar") {
    odabraniDanKey = null;
    ucitajKalendar();
  } else {
    prikaziZahtjeve();
  }
}

// ── Tabovi ──
function promijeniTab(tab) {
  aktivniTab = tab;

  ["cekanje", "povijest", "kalendar"].forEach(t => {
    const el = document.getElementById(`nav-${t}`);
    if (el) el.classList.toggle("active", t === tab);
  });

  const naslovi = { cekanje: "Na čekanju", povijest: "Povijest", kalendar: "Kalendar" };
  const titleEl = document.getElementById("adminTitle");
  if (titleEl) titleEl.textContent = naslovi[tab] || "Admin";

  if (tab === "kalendar") {
    odabraniDanKey = null;
    ucitajKalendar();
  } else {
    prikaziZahtjeve();
  }
}

// ── Prikaz zahtjeva ──
function prikaziZahtjeve() {
  const aktivniDoktor = sviDoktori[aktivniDoktorIdx];

  let filtrirani = sviZahtjevi.filter(z =>
    aktivniTab === "cekanje"
      ? z.status === "na_cekanju"
      : z.status !== "na_cekanju"
  );

  // Filtriraj po doktoru ako postoje doktori
  if (aktivniDoktor) {
    filtrirani = filtrirani.filter(z => z.doctorId === aktivniDoktor.id);
  }

  // Badge
  const pendingCount = sviDoktori.length > 0
    ? sviZahtjevi.filter(z => z.status === "na_cekanju" && z.doctorId === (sviDoktori[aktivniDoktorIdx]?.id || "")).length
    : sviZahtjevi.filter(z => z.status === "na_cekanju").length;
  const badge = document.getElementById("nav-pending-badge");
  if (badge) {
    badge.textContent = pendingCount;
    badge.style.display = pendingCount > 0 ? "inline-block" : "none";
  }

  const switcher = doktorSwitcherHTML();

  if (filtrirani.length === 0) {
    wrap.innerHTML = switcher + `<p class="prazno">${aktivniTab === "cekanje" ? "Nema zahtjeva na čekanju." : "Nema završenih zahtjeva."}</p>`;
    return;
  }

  wrap.innerHTML = switcher + filtrirani.map(z => `
    <div class="zahtjev-card" style="${z.status !== 'na_cekanju' ? 'opacity:0.75;' : ''}">
      <div class="zahtjev-header">
        <span class="zahtjev-ime">${esc(z.name)}</span>
        <div style="display:flex; align-items:center; gap:12px;">
          ${z.status === 'potvrdjeno' ? `<span class="status-badge status-potvrdjeno">Potvrđeno</span>` : ''}
          ${z.status === 'predlozeno' ? `<span class="status-badge status-predlozeno">Predloženo</span>` : ''}
          ${z.status === 'otkazano'   ? `<span class="status-badge status-otkazano">Otkazano</span>` : ''}
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
          <button class="btn-predlozi" onclick="predlozi(${esc(z.id)})">Predloži drugi</button>
        </div>
      ` : ''}
      ${z.status === 'potvrdjeno' ? `
        <div class="zahtjev-akcije">
          <button class="btn-otkazi" onclick="otkazi(${esc(z.id)})">Otkaži termin</button>
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

async function otkazi(id) {
  if (!confirm("Jeste li sigurni da želite otkazati ovaj termin? Pacijent će biti obaviješten mailom.")) return;

  const res = await fetch("/admin-cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, id }),
  });
  const data = await res.json();

  if (data.ok) {
    alert("Termin je otkazan. Pacijent je obaviješten.");
    ucitajZahtjeve();
  } else {
    alert("Greška pri otkazivanju.");
  }
}

// ── Init zahtjevi ──
async function ucitajZahtjeve() {
  const dataRes = await fetch(`/admin-data/${clientId}?token=${adminToken}`);

  if (dataRes.status === 403) {
    sessionStorage.removeItem("adminToken_" + clientId);
    window.location.href = "/login/" + clientId;
    return;
  }

  const data = await dataRes.json();

  // Učitaj raspored radnog vremena
  try {
    const cfgRes = await fetch(`/config/${clientId}`);
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      workingHoursSchedule = cfg.workingHoursSchedule || {};
    }
  } catch { workingHoursSchedule = {}; }

  title.textContent = "Na čekanju";
  sviZahtjevi = data.zahtjevi;
  sviDoktori = data.doctors || [];

  const sidebarBrand = document.getElementById("sidebarBrand");
  if (sidebarBrand) sidebarBrand.textContent = data.brandName;
  const topbarOrdinacija = document.getElementById("topbarOrdinacija");
  if (topbarOrdinacija) topbarOrdinacija.textContent = data.brandName;

  prikaziZahtjeve();
}

// ── Kalendar ──
async function ucitajKalendar() {
  try {
    const aktivniDoktor = sviDoktori[aktivniDoktorIdx];
    const doctorParam = aktivniDoktor ? `&doctorId=${encodeURIComponent(aktivniDoktor.id)}` : "";
    const res = await fetch(`/admin-kalendar/${clientId}?token=${adminToken}${doctorParam}`);
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

  const terminiHTML = odabraniDanKey
    ? napraviTermine(odabraniDanKey)
    : `<div class="kal-placeholder">
         <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
         <span>Odaberite dan za prikaz termina</span>
       </div>`;
  const naslov = `${MJES_NAZIVI[kalendarMjesec]} ${kalendarGodina}`;

  wrap.innerHTML = `
    ${doktorSwitcherHTML()}
    <div class="kal-wrap">
      <div class="kal-layout">
        <div class="kal-lijevo">
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
        </div>
        <div class="kal-desno">
          ${terminiHTML}
        </div>
      </div>
    </div>
  `;
}

function napraviTermine(dateKey) {
  const zauzetiTermini = kalendarData[dateKey] || [];
  const zauzetoMap = {};
  for (const t of zauzetiTermini) {
    zauzetoMap[t.time] = t;
  }

  const [g, mj, d] = dateKey.split("-");
  const hrDatum = `${parseInt(d)}. ${parseInt(mj)}. ${g}.`;

  const danTjedna = new Date(parseInt(g), parseInt(mj) - 1, parseInt(d)).getDay();
  const raspon = workingHoursSchedule[String(danTjedna)];
  const slotovi = raspon ? generirajTermine(raspon) : [];

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

ucitajZahtjeve();
