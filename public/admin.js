const dijelovi = window.location.pathname.split("/");
const clientId = dijelovi[2];

const adminToken = sessionStorage.getItem("adminToken_" + clientId);
if (!adminToken) {
  window.location.href = "/admin";
} else {
  document.body.style.visibility = "visible";
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

// Radno vrijeme tab
let rvDoktorIdx = 0;
let rvGodina = null;
let rvMjesec = null;
let rvOdabraniDan = null;
let rvIznimke = {};     // { "2025-03-15": [{id, type, time, note}, ...] }
let rvSchedule = {};    // { "1": {startTime, endTime}, ... } za aktivnog doktora

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
    </div>`;
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

  ["cekanje", "povijest", "kalendar", "radno-vrijeme"].forEach(t => {
    const el = document.getElementById(`nav-${t}`);
    if (el) el.classList.toggle("active", t === tab);
  });

  const naslovi = {
    cekanje: "Na čekanju",
    povijest: "Povijest",
    kalendar: "Kalendar",
    "radno-vrijeme": "Radno vrijeme",
  };
  const titleEl = document.getElementById("adminTitle");
  if (titleEl) titleEl.textContent = naslovi[tab] || "Admin";

  if (tab === "kalendar") {
    odabraniDanKey = null;
    ucitajKalendar();
  } else if (tab === "radno-vrijeme") {
    rvOdabraniDan = null;
    if (rvGodina === null) rvGodina = new Date().getFullYear();
    if (rvMjesec === null) rvMjesec = new Date().getMonth();
    ucitajRasporedTab();
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

  if (aktivniDoktor) {
    filtrirani = filtrirani.filter(z => z.doctorId === aktivniDoktor.id);
  }

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
  const zahtjev = sviZahtjevi.find(z => z.id == id);
  if (!zahtjev) return;

  const res = await fetch("/admin-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, id, akcija: "potvrdi", termin: zahtjev.date }),
  });
  const data = await res.json();

  if (data.ok) {
    alert("Potvrda poslana pacijentu!");
    ucitajZahtjeve();
  } else {
    alert("Greška pri slanju potvrde.");
  }
}

async function predlozi(id) {
  const termin = prompt("Upiši prijedlog termina (npr. 16.03. u 14:00):");
  if (!termin) return;

  const res = await fetch("/admin-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, id, akcija: "predlozi", termin }),
  });
  const data = await res.json();

  if (data.ok) {
    alert("Prijedlog poslan pacijentu!");
    ucitajZahtjeve();
  } else {
    alert("Greška pri slanju prijedloga.");
  }
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

// ── Radno vrijeme tab ──

async function ucitajRasporedTab() {
  if (sviDoktori.length === 0) {
    wrap.innerHTML = `<p class="prazno">Ova ordinacija nema definiranih doktora.</p>`;
    return;
  }
  const doktor = sviDoktori[rvDoktorIdx];
  const [rasporedRes, iznimkeRows] = await Promise.all([
    fetch(`/admin-raspored/${clientId}?doctorId=${encodeURIComponent(doktor.id)}`, { headers: { "Authorization": `Bearer ${adminToken}` } }).then(r => r.json()),
    ucitajRvIznimke(doktor.id),
  ]);
  rvSchedule = rasporedRes.schedule || {};
  renderRasporedView(doktor);
}

async function ucitajRvIznimke(doctorId) {
  const res = await fetch(
    `/admin-iznimke/${clientId}?doctorId=${encodeURIComponent(doctorId)}&year=${rvGodina}&month=${rvMjesec + 1}`,
    { headers: { "Authorization": `Bearer ${adminToken}` } }
  );
  const rows = await res.json();
  rvIznimke = {};
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!rvIznimke[r.date]) rvIznimke[r.date] = [];
    rvIznimke[r.date].push(r);
  }
}

function promijeniRvDoktora(smjer) {
  rvDoktorIdx = (rvDoktorIdx + smjer + sviDoktori.length) % sviDoktori.length;
  rvOdabraniDan = null;
  ucitajRasporedTab();
}

async function promijeniRvMjesec(smjer) {
  rvMjesec += smjer;
  if (rvMjesec > 11) { rvMjesec = 0; rvGodina++; }
  if (rvMjesec < 0)  { rvMjesec = 11; rvGodina--; }
  rvOdabraniDan = null;
  await ucitajRvIznimke(sviDoktori[rvDoktorIdx].id);
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

function odaberiRvDan(key) {
  rvOdabraniDan = rvOdabraniDan === key ? null : key;
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

function toggleRvDan(dayNum) {
  const chk = document.getElementById(`rv-toggle-${dayNum}`);
  const inputs = document.getElementById(`rv-inputs-${dayNum}`);
  if (!chk || !inputs) return;
  inputs.style.opacity = chk.checked ? "1" : "0.35";
  inputs.style.pointerEvents = chk.checked ? "" : "none";
}

async function spremiRaspored() {
  const doktor = sviDoktori[rvDoktorIdx];
  const schedule = {};
  for (let day = 0; day <= 6; day++) {
    const chk = document.getElementById(`rv-toggle-${day}`);
    if (chk && chk.checked) {
      const start = document.getElementById(`rv-start-${day}`)?.value;
      const end   = document.getElementById(`rv-end-${day}`)?.value;
      if (start && end) schedule[String(day)] = { startTime: start, endTime: end };
    }
  }
  const res = await fetch("/admin-raspored", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, doctorId: doktor.id, schedule }),
  });
  const data = await res.json();
  if (data.ok) {
    const poruka = data.otkazano > 0
      ? `Raspored spremljen.\n\nAutomatski otkazano ${data.otkazano} potvrđenih termina koji više ne odgovaraju novom rasporedu. Pacijenti su obaviješteni mailom.`
      : "Raspored spremljen.";
    alert(poruka);
    rvSchedule = schedule;
    renderRasporedView(doktor);
  } else {
    alert("Greška pri spremanju.");
  }
}

async function blokirajDan(doctorId, date) {
  const res = await fetch("/admin-iznimka", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, token: adminToken, doctorId, date, type: "block_day" }),
  });
  const data = await res.json();
  if (data.ok) {
    await ucitajRvIznimke(doctorId);
    renderRasporedView(sviDoktori[rvDoktorIdx]);
  }
}

async function ukloniBlokadeDana(doctorId, date) {
  const iznimkeZaDan = rvIznimke[date] || [];
  const blokade = iznimkeZaDan.filter(i => i.type === "block_day");
  for (const b of blokade) {
    await fetch("/admin-iznimka-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, token: adminToken, id: b.id }),
    });
  }
  await ucitajRvIznimke(doctorId);
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

async function toggleSlotBlokada(doctorId, date, time) {
  const iznimkeZaDan = rvIznimke[date] || [];
  const existing = iznimkeZaDan.find(i => i.type === "block_slot" && i.time === time);
  if (existing) {
    await fetch("/admin-iznimka-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, token: adminToken, id: existing.id }),
    });
  } else {
    await fetch("/admin-iznimka", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, token: adminToken, doctorId, date, type: "block_slot", time }),
    });
  }
  await ucitajRvIznimke(doctorId);
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

function renderRasporedView(doktor) {
  const DANI = ["Nedjelja", "Ponedjeljak", "Utorak", "Srijeda", "Četvrtak", "Petak", "Subota"];
  const ORDEN = [1, 2, 3, 4, 5, 6, 0];

  // Doctor switcher
  const switcher = sviDoktori.length > 1 ? `
    <div class="doctor-switcher" style="margin-bottom:20px;">
      <span class="doctor-switcher-label">Doktor</span>
      <button class="doctor-arrow" onclick="promijeniRvDoktora(-1)">&#8592;</button>
      <span class="doctor-switcher-name">${esc(doktor.name)}</span>
      <button class="doctor-arrow" onclick="promijeniRvDoktora(1)">&#8594;</button>
    </div>` : `<div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:16px;">${esc(doktor.name)}</div>`;

  // Weekly schedule rows
  const danRows = ORDEN.map(day => {
    const entry = rvSchedule[String(day)];
    const on = !!entry;
    const s = entry?.startTime || "08:00";
    const e = entry?.endTime   || "17:00";
    return `
      <div class="rv-dan-row">
        <span class="rv-dan-label">${DANI[day]}</span>
        <input type="checkbox" class="rv-toggle" id="rv-toggle-${day}" ${on ? "checked" : ""}
               onchange="toggleRvDan(${day})">
        <div class="rv-dan-inputs" id="rv-inputs-${day}" style="${on ? "" : "opacity:0.35;pointer-events:none;"}">
          <input type="time" id="rv-start-${day}" value="${s}">
          <span class="rv-dan-sep">—</span>
          <input type="time" id="rv-end-${day}" value="${e}">
        </div>
      </div>`;
  }).join("");

  // Exceptions calendar
  const prviDan   = new Date(rvGodina, rvMjesec, 1);
  const zadnjiDan = new Date(rvGodina, rvMjesec + 1, 0).getDate();
  let offset = prviDan.getDay() - 1;
  if (offset < 0) offset = 6;

  const headerHTML = ["Po","Ut","Sr","Če","Pe","Su","Ne"]
    .map(d => `<div class="kal-header-dan">${d}</div>`).join("");
  const prazneHTML = Array(offset).fill('<div class="kal-dan kal-prazan"></div>').join("");

  const danasKey = isoKey(new Date());
  let daniHTML = "";
  for (let d = 1; d <= zadnjiDan; d++) {
    const key = isoKey(new Date(rvGodina, rvMjesec, d));
    const iznimkeKey = rvIznimke[key] || [];
    const blokiranDan   = iznimkeKey.some(i => i.type === "block_day");
    const imaSlotBlok   = iznimkeKey.some(i => i.type === "block_slot");
    const jeOdabran     = key === rvOdabraniDan;
    const jeDanas       = key === danasKey;

    let klase = "kal-dan";
    if (jeOdabran)                    klase += " kal-odabran";
    else if (blokiranDan)             klase += " kal-blokiran-dan";
    else if (imaSlotBlok)             klase += " kal-ima-slot-blokada";
    if (jeDanas && !jeOdabran)        klase += " kal-danas";

    daniHTML += `<div class="${klase}" onclick="odaberiRvDan('${key}')">${d}</div>`;
  }

  // Right panel: selected day actions
  let panelHTML;
  if (rvOdabraniDan) {
    const [g, mj, dd] = rvOdabraniDan.split("-");
    const hrDatum = `${parseInt(dd)}. ${parseInt(mj)}. ${g}.`;
    const iznimkeKey = rvIznimke[rvOdabraniDan] || [];
    const blokiranDan = iznimkeKey.some(i => i.type === "block_day");
    const dayOfWeek   = new Date(parseInt(g), parseInt(mj) - 1, parseInt(dd)).getDay();
    const raspon      = rvSchedule[String(dayOfWeek)];
    const slotovi     = raspon ? generirajTermine(`${raspon.startTime}-${raspon.endTime}`) : [];

    const danGumb = blokiranDan
      ? `<button class="iznimke-panel-btn ukloni-blokadu" onclick="ukloniBlokadeDana('${esc(doktor.id)}', '${rvOdabraniDan}')">✓ Ukloni blokadu dana</button>`
      : `<button class="iznimke-panel-btn blokira" onclick="blokirajDan('${esc(doktor.id)}', '${rvOdabraniDan}')">⊘ Blokira cijeli dan</button>`;

    let slotHTML = "";
    if (!blokiranDan && slotovi.length > 0) {
      const slotsRows = slotovi.map(t => {
        const blokiran = iznimkeKey.some(i => i.type === "block_slot" && i.time === t);
        return `
          <div class="iznimke-slot-row">
            <span class="iznimke-slot-time ${blokiran ? "blokiran" : ""}">${esc(t)}</span>
            <button class="btn-blokira-slot ${blokiran ? "aktivan" : "neaktivan"}"
                    onclick="toggleSlotBlokada('${esc(doktor.id)}','${rvOdabraniDan}','${t}')">
              ${blokiran ? "Ukloni" : "Blokira"}
            </button>
          </div>`;
      }).join("");
      slotHTML = `<div style="margin-top:12px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Termini tog dana</div>${slotsRows}`;
    } else if (!blokiranDan && slotovi.length === 0) {
      slotHTML = `<p style="font-size:13px;color:var(--muted);margin-top:10px;">Doktor ne radi taj dan — nema termina za blokiranje.</p>`;
    }

    panelHTML = `
      <div class="iznimke-panel">
        <div class="iznimke-panel-naslov">${esc(hrDatum)}</div>
        ${danGumb}
        ${slotHTML}
      </div>`;
  } else {
    panelHTML = `
      <div class="kal-placeholder" style="min-height:160px;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span>Odaberite dan za upravljanje iznimkama</span>
      </div>`;
  }

  wrap.innerHTML = `
    <div class="rv-wrap">
      ${switcher}

      <div class="rv-sekcija">
        <div class="rv-sekcija-naslov">Tjedno radno vrijeme</div>
        ${danRows}
        <button class="rv-spremi-btn" onclick="spremiRaspored()">Spremi raspored</button>
      </div>

      <div class="rv-sekcija">
        <div class="rv-sekcija-naslov">Iznimke — slobodni dani i blokade termina</div>
        <div class="kal-layout">
          <div>
            <div class="kal-nav">
              <button class="kal-nav-btn" onclick="promijeniRvMjesec(-1)">&#8592;</button>
              <span class="kal-mjes">${esc(MJES_NAZIVI[rvMjesec])} ${rvGodina}</span>
              <button class="kal-nav-btn" onclick="promijeniRvMjesec(1)">&#8594;</button>
            </div>
            <div class="kal-card">
              <div class="kal-grid">
                ${headerHTML}
                ${prazneHTML}
                ${daniHTML}
              </div>
            </div>
          </div>
          <div>${panelHTML}</div>
        </div>
      </div>
    </div>`;
}

// ── Init zahtjevi ──
async function ucitajZahtjeve() {
  const dataRes = await fetch(`/admin-data/${clientId}`, { headers: { "Authorization": `Bearer ${adminToken}` } });

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
    const doctorParam = aktivniDoktor ? `?doctorId=${encodeURIComponent(aktivniDoktor.id)}` : "";
    const res = await fetch(`/admin-kalendar/${clientId}${doctorParam}`, { headers: { "Authorization": `Bearer ${adminToken}` } });
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
