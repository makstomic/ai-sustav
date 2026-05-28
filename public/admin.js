const dijelovi = window.location.pathname.split("/");
const clientId = dijelovi[2];

document.body.style.visibility = "visible";

let _csrfToken = "";

function adminPost(url, body) {
  return fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": _csrfToken },
    body:    JSON.stringify(body),
  });
}

const wrap  = document.getElementById("zahtjevi");
const title = document.getElementById("adminTitle");

let sviZahtjevi    = [];
let aktivniTab     = "cekanje";
let aktivniStTab   = "na_cekanju";   // sub-tab u zahtjevima
let kalendarData   = {};
let kalendarGodina = null;
let kalendarMjesec = null;
let odabraniDanKey = null;
let workingHoursSchedule = {};

let sviDoktori      = [];
let aktivniDoktorIdx = 0;
let kalDrIdx         = -1;  // -1 = Svi
let rvDoktorIdx      = 0;
let rvAlternativni   = false;
let rvNeradniDani    = new Set();
let rvScheduleB      = {};
let rvGodina         = null;
let rvMjesec         = null;
let rvOdabraniDan    = null;
let rvIznimke        = {};
let rvSchedule       = {};

const MJES_NAZIVI = ["Siječanj","Veljača","Ožujak","Travanj","Svibanj","Lipanj",
                     "Srpanj","Kolovoz","Rujan","Listopad","Studeni","Prosinac"];

// ── Helpers ──────────────────────────────────────────────────────────────────
//
// XSS napomena: sve renderXXX funkcije koje koriste innerHTML escaju user-controlled
// podatke kroz esc(). Inline onclick atributi u generiranom HTML-u (npr. onclick="potvrdi(123)")
// koriste samo hardkodirane nazive funkcija i numeričke ID-eve iz baze — bez user stringa.
//
// TODO (CSP): za maknuti 'unsafe-inline' iz CSP trebat će migrirati inline onclicke u
// addEventListener. Mjesta s inline onclick: doktorSwitcherHTML, prikaziKalendar,
// napraviTermine, renderRasporedView, renderRequestRow, renderTelefonTab, renderPostavkeView.

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pageHeadingHTML(title, meta = "") {
  return `<div class="page-heading"><h1>${esc(title)}</h1>${meta ? `<span class="page-heading-meta">${esc(meta)}</span>` : ""}</div>`;
}

// ── Custom Select ─────────────────────────────────────────────────────────────

function buildCsHTML(fieldId, selectedValue, options, placeholder) {
  const selVal = String(selectedValue ?? "");
  const current = options.find(o => String(o.value ?? o.label) === selVal);
  const label = current ? current.label : "";
  const optHTML = options.map(o => {
    const val = String(o.value ?? o.label);
    const sel = val === selVal;
    return `<button type="button" class="cs-opt${sel ? " is-selected" : ""}" data-value="${esc(val)}" onclick="csOptClick(this,'${fieldId}')">
      <span class="cs-opt-label">${esc(o.label)}</span>
      ${o.hint ? `<span class="cs-opt-hint">${esc(o.hint)}</span>` : ""}
      ${sel ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="cs-check"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
    </button>`;
  }).join("");
  return `<div class="cs-wrap" id="${fieldId}-cs">
    <input type="hidden" id="${fieldId}" value="${esc(selVal)}">
    <button type="button" class="cs-trigger" onclick="csToggle('${fieldId}',event)">
      <span class="cs-value${label ? "" : " cs-placeholder"}" id="${fieldId}-display">${label ? esc(label) : esc(placeholder || "Odaberi…")}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="cs-chev"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="cs-pop" id="${fieldId}-pop">${optHTML}</div>
  </div>`;
}

function _csPosition(fieldId) {
  const wrap = document.getElementById(`${fieldId}-cs`);
  const pop  = document.getElementById(`${fieldId}-pop`);
  if (!wrap || !pop) return;
  const trigger = wrap.querySelector(".cs-trigger");
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  pop.style.top   = (r.bottom + 6) + "px";
  pop.style.width = r.width + "px";
  if (pop.classList.contains("cs-pop--cal")) {
    pop.style.left  = "auto";
    pop.style.right = (window.innerWidth - r.right) + "px";
    pop.style.width = "260px";
  } else {
    pop.style.left  = r.left + "px";
    pop.style.right = "auto";
  }
}

function csToggle(fieldId, e) {
  if (e) e.stopPropagation();
  const wrap = document.getElementById(`${fieldId}-cs`);
  if (!wrap) return;
  const opening = !wrap.classList.contains("is-open");
  document.querySelectorAll(".cs-wrap.is-open").forEach(w => w.classList.remove("is-open"));
  if (opening) { wrap.classList.add("is-open"); _csPosition(fieldId); }
}

function csOptClick(btn, fieldId) {
  const value = btn.dataset.value;
  const label = btn.querySelector(".cs-opt-label")?.textContent || value;
  const hiddenEl  = document.getElementById(fieldId);
  const displayEl = document.getElementById(`${fieldId}-display`);
  const wrap      = document.getElementById(`${fieldId}-cs`);
  if (hiddenEl) hiddenEl.value = value;
  if (displayEl) { displayEl.textContent = label; displayEl.classList.remove("cs-placeholder"); }
  wrap?.querySelectorAll(".cs-opt").forEach(opt => {
    const sel = opt.dataset.value === value;
    opt.classList.toggle("is-selected", sel);
    const chk = opt.querySelector(".cs-check");
    if (sel && !chk) opt.insertAdjacentHTML("beforeend", `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="cs-check"><polyline points="20 6 9 17 4 12"/></svg>`);
    else if (!sel && chk) chk.remove();
  });
  wrap?.classList.remove("is-open");
  if (fieldId === "tel-doktor") ucitajTelefonTermine();
}

// ── Date Picker ───────────────────────────────────────────────────────────────

const _dpState = {};
const _MJES_DP = ["Siječanj","Veljača","Ožujak","Travanj","Svibanj","Lipanj","Srpanj","Kolovoz","Rujan","Listopad","Studeni","Prosinac"];

function _dpToday() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`;
}

function _dpFmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)}. ${parseInt(m)}. ${y}.`;
}

function _dpRenderGrid(fieldId) {
  const s = _dpState[fieldId];
  if (!s) return;
  const today     = _dpToday();
  const daysInMon = new Date(s.year, s.month, 0).getDate();
  const jsDay     = new Date(s.year, s.month - 1, 1).getDay();
  const leading   = (jsDay + 6) % 7;
  const cells     = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMon; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const titleEl = document.getElementById(`${fieldId}-dp-title`);
  const gridEl  = document.getElementById(`${fieldId}-dp-grid`);
  if (titleEl) titleEl.textContent = `${_MJES_DP[s.month - 1]} ${s.year}.`;
  if (!gridEl) return;

  const dows = ["P","U","S","Č","P","S","N"].map(d => `<div class="dp-dow">${d}</div>`).join("");
  const days = cells.map(cell => {
    if (cell === null) return `<div class="dp-day dp-day--blank"></div>`;
    const iso     = `${s.year}-${String(s.month).padStart(2,"0")}-${String(cell).padStart(2,"0")}`;
    const sel     = s.value === iso;
    const isToday = iso === today;
    const dow     = new Date(s.year, s.month - 1, cell).getDay();
    const weekend = dow === 0 || dow === 6;
    if (s.minDate && iso < s.minDate) return `<div class="dp-day dp-day--blank" style="opacity:0.28">${cell}</div>`;
    return `<button type="button" class="dp-day${sel ? " is-selected" : ""}${isToday ? " is-today" : ""}${weekend ? " is-weekend" : ""}" data-iso="${iso}" onclick="dpDayClick(this,'${fieldId}')">${cell}</button>`;
  }).join("");

  gridEl.innerHTML = dows + days;
}

function buildDpHTML(fieldId, value, minDate, placeholder) {
  const today   = _dpToday();
  const init    = value || today;
  const [iy, im] = init.split("-").map(Number);
  _dpState[fieldId] = { year: iy, month: im, value: value || "", minDate: minDate || today };
  const display = value ? _dpFmtDate(value) : "";
  return `<div class="cs-wrap" id="${fieldId}-cs">
    <input type="hidden" id="${fieldId}" value="${esc(value || "")}">
    <button type="button" class="cs-trigger" onclick="dpToggle('${fieldId}',event)">
      <span class="cs-value${display ? "" : " cs-placeholder"}" id="${fieldId}-display">${display ? esc(display) : esc(placeholder || "Odaberi datum")}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.45;color:var(--muted)"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    </button>
    <div class="cs-pop cs-pop--cal" id="${fieldId}-pop">
      <div class="dp-head">
        <button type="button" class="dp-nav" onclick="dpNav('${fieldId}',-1,event)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="dp-title" id="${fieldId}-dp-title"></div>
        <button type="button" class="dp-nav" onclick="dpNav('${fieldId}',1,event)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="dp-grid" id="${fieldId}-dp-grid"></div>
    </div>
  </div>`;
}

function dpToggle(fieldId, e) {
  if (e) e.stopPropagation();
  const wrap = document.getElementById(`${fieldId}-cs`);
  if (!wrap) return;
  const opening = !wrap.classList.contains("is-open");
  document.querySelectorAll(".cs-wrap.is-open").forEach(w => w.classList.remove("is-open"));
  if (opening) { wrap.classList.add("is-open"); _dpRenderGrid(fieldId); _csPosition(fieldId); }
}

function dpNav(fieldId, dir, e) {
  if (e) e.stopPropagation();
  const s = _dpState[fieldId];
  if (!s) return;
  s.month += dir;
  if (s.month > 12) { s.month = 1; s.year++; }
  if (s.month < 1)  { s.month = 12; s.year--; }
  _dpRenderGrid(fieldId);
}

function dpDayClick(btn, fieldId) { dpPick(fieldId, btn.dataset.iso); }

function dpPick(fieldId, iso) {
  const s = _dpState[fieldId];
  if (s) s.value = iso;
  const hiddenEl  = document.getElementById(fieldId);
  const displayEl = document.getElementById(`${fieldId}-display`);
  const wrap      = document.getElementById(`${fieldId}-cs`);
  if (hiddenEl) hiddenEl.value = iso;
  if (displayEl) { displayEl.textContent = _dpFmtDate(iso); displayEl.classList.remove("cs-placeholder"); }
  wrap?.classList.remove("is-open");
  if (fieldId === "tel-datum") ucitajTelefonTermine();
}

function parseNote(note) {
  if (!note || note === "—") return { phone: null, text: null };
  const m = note.match(/^Tel:\s*([^|]+?)(?:\s*\|\s*(.*))?$/);
  if (m) return { phone: m[1].trim() || null, text: m[2]?.trim() || null };
  return { phone: null, text: note };
}

function isoKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function generirajTermine(raspon) {
  if (!raspon) return [];
  const [od, do_] = raspon.split("-");
  const [odH, odM] = od.split(":").map(Number);
  const [doH, doM] = do_.split(":").map(Number);
  const termini = [];
  let h = odH, m = odM;
  while (h * 60 + m < doH * 60 + doM) {
    termini.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);
    m += 30; if (m >= 60) { m -= 60; h++; }
  }
  return termini;
}

function parseDateTime(dateStr) {
  const match = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.\s+u\s+(\d{2}:\d{2})/);
  if (!match) return null;
  const [, dan, mjes, god, vrijeme] = match;
  return { dan: parseInt(dan), mjes: parseInt(mjes), god: parseInt(god), vrijeme };
}

// ── Custom Time Picker ────────────────────────────────────────────────────────

function buildTimePicker(id, value) {
  const [hStr, mStr] = value.split(":");
  const hVal = parseInt(hStr, 10);
  const mVal = parseInt(mStr, 10);

  const hours = Array.from({length: 24}, (_, i) => i);
  const mins  = Array.from({length: 60}, (_, i) => i);

  const hItems = hours.map(h =>
    `<button class="time-picker-item${h === hVal ? " is-selected" : ""}"
             onclick="tpSelectH('${id}',${h})">${String(h).padStart(2,"0")}</button>`
  ).join("");

  const mItems = mins.map(m =>
    `<button class="time-picker-item${m === mVal ? " is-selected" : ""}"
             onclick="tpSelectM('${id}',${m})">${String(m).padStart(2,"0")}</button>`
  ).join("");

  return `
    <div class="time-picker" id="tp-${id}">
      <button class="time-picker-btn" onclick="tpToggle('${id}')">${value}</button>
      <div class="time-picker-drop" id="tp-drop-${id}">
        <div class="time-picker-col" id="tp-hcol-${id}">
          <div class="time-picker-col-head">h</div>
          ${hItems}
        </div>
        <div class="time-picker-col" id="tp-mcol-${id}">
          <div class="time-picker-col-head">min</div>
          ${mItems}
        </div>
      </div>
    </div>`;
}

function tpToggle(id) {
  const drop = document.getElementById(`tp-drop-${id}`);
  const btn  = drop?.previousElementSibling;
  if (!drop) return;

  // close all others
  document.querySelectorAll(".time-picker-drop.is-open").forEach(d => {
    if (d !== drop) {
      d.classList.remove("is-open");
      d.previousElementSibling?.classList.remove("is-open");
    }
  });

  const isOpen = drop.classList.toggle("is-open");
  btn?.classList.toggle("is-open", isOpen);

  if (isOpen) {
    // scroll selected item into view
    const selH = document.querySelector(`#tp-hcol-${id} .is-selected`);
    const selM = document.querySelector(`#tp-mcol-${id} .is-selected`);
    selH?.scrollIntoView({ block: "center" });
    selM?.scrollIntoView({ block: "center" });
  }
}

function tpSelectH(id, h) {
  const col = document.getElementById(`tp-hcol-${id}`);
  if (!col) return;
  col.querySelectorAll(".time-picker-item").forEach((btn, i) => btn.classList.toggle("is-selected", i === h));
  _tpUpdateBtn(id);
}

function tpSelectM(id, m) {
  const col = document.getElementById(`tp-mcol-${id}`);
  if (!col) return;
  col.querySelectorAll(".time-picker-item").forEach((btn, i) => btn.classList.toggle("is-selected", i === m));
  _tpUpdateBtn(id);
}

function _tpUpdateBtn(id) {
  const hSel = document.querySelector(`#tp-hcol-${id} .is-selected`);
  const mSel = document.querySelector(`#tp-mcol-${id} .is-selected`);
  const btn  = document.querySelector(`#tp-${id} .time-picker-btn`);
  if (!hSel || !mSel || !btn) return;
  const h = String(document.querySelector(`#tp-hcol-${id}`).querySelectorAll(".time-picker-item").length > 0
    ? Array.from(document.querySelector(`#tp-hcol-${id}`).querySelectorAll(".time-picker-item")).indexOf(hSel)
    : 0).padStart(2, "0");
  const m = String(Array.from(document.querySelector(`#tp-mcol-${id}`).querySelectorAll(".time-picker-item")).indexOf(mSel)).padStart(2, "0");
  btn.textContent = `${h}:${m}`;
}

function tpGetValue(id) {
  const btn = document.querySelector(`#tp-${id} .time-picker-btn`);
  return btn ? btn.textContent.trim() : "00:00";
}

// ── Doctor switcher ───────────────────────────────────────────────────────────

function doktorSwitcherHTML(idx, onPrev, onNext) {
  if (sviDoktori.length === 0) return "";
  const ime = sviDoktori[idx]?.name || "—";
  if (sviDoktori.length === 1)
    return `<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:14px;">${esc(ime)}</div>`;
  return `
    <div class="doctor-switcher">
      <span class="doctor-switcher-label">Doktor</span>
      <button class="doctor-arrow" onclick="${onPrev}">&#8592;</button>
      <span class="doctor-switcher-name">${esc(ime)}</span>
      <button class="doctor-arrow" onclick="${onNext}">&#8594;</button>
    </div>`;
}

function promijeniDoktora(smjer) {
  aktivniDoktorIdx = (aktivniDoktorIdx + smjer + sviDoktori.length) % sviDoktori.length;
  if (aktivniTab === "kalendar") { odabraniDanKey = null; ucitajKalendar(); }
  else prikaziZahtjeve();
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function promijeniTab(tab) {
  aktivniTab = tab;
  ["cekanje","kalendar","radno-vrijeme","telefon","postavke"].forEach(t => {
    document.getElementById(`nav-${t}`)?.classList.toggle("active", t === tab);
  });
  const naslovi = {
    cekanje:         "Na čekanju",
    kalendar:        "Kalendar",
    "radno-vrijeme": "Radno vrijeme",
    telefon:         "Unos s telefona",
    postavke:        "Postavke",
  };
  const titleEl = document.getElementById("adminTitle");
  if (titleEl) titleEl.textContent = naslovi[tab] || "Admin";

  if (tab === "kalendar") { odabraniDanKey = null; ucitajKalendar(); }
  else if (tab === "radno-vrijeme") {
    rvOdabraniDan = null;
    if (rvGodina === null) rvGodina = new Date().getFullYear();
    if (rvMjesec === null) rvMjesec = new Date().getMonth();
    ucitajRasporedTab();
  } else if (tab === "telefon") {
    renderTelefonTab();
  } else if (tab === "postavke") {
    ucitajPostavke();
  } else {
    prikaziZahtjeve();
  }
}

function promijeniStTab(tab) {
  aktivniStTab = tab;
  prikaziZahtjeve();
}

// ── Zahtjevi — flat row prikaz ────────────────────────────────────────────────

function prikaziZahtjeve() {
  const aktivniDoktor = sviDoktori[aktivniDoktorIdx];

  let filtrirani = sviZahtjevi;
  if (aktivniDoktor) filtrirani = filtrirani.filter(z => z.doctorId === aktivniDoktor.id);

  const cekanje  = filtrirani.filter(z => z.status === "na_cekanju");
  const odbijeni = filtrirani.filter(z => z.status === "odbijeno");
  const otkazani = filtrirani.filter(z => z.status === "otkazano");

  const pendingCount = sviZahtjevi.filter(z =>
    z.status === "na_cekanju" &&
    (!aktivniDoktor || z.doctorId === aktivniDoktor.id)
  ).length;
  const badge = document.getElementById("nav-pending-badge");
  if (badge) { badge.textContent = pendingCount; badge.style.display = pendingCount > 0 ? "inline-block" : "none"; }

  let listaZaPrikaz;
  if (aktivniStTab === "na_cekanju") listaZaPrikaz = cekanje;
  else if (aktivniStTab === "odbijeno") listaZaPrikaz = odbijeni;
  else listaZaPrikaz = otkazani;

  const switcher = doktorSwitcherHTML(aktivniDoktorIdx, "promijeniDoktora(-1)", "promijeniDoktora(1)");

  const statusTabsHTML = `
    <div class="panel-head">
      <div class="status-tabs">
        <button class="status-tab${aktivniStTab === "na_cekanju" ? " is-active" : ""}"
                onclick="promijeniStTab('na_cekanju')">
          Na čekanju <span class="status-tab-count">${cekanje.length}</span>
        </button>
        <button class="status-tab${aktivniStTab === "odbijeno" ? " is-active" : ""}"
                onclick="promijeniStTab('odbijeno')">
          Odbijeni <span class="status-tab-count">${odbijeni.length}</span>
        </button>
        <button class="status-tab${aktivniStTab === "otkazano" ? " is-active" : ""}"
                onclick="promijeniStTab('otkazano')">
          Otkazani <span class="status-tab-count">${otkazani.length}</span>
        </button>
      </div>
    </div>`;

  const rowsHTML = listaZaPrikaz.length === 0
    ? `<div class="prazno">Nema zahtjeva u ovoj kategoriji.</div>`
    : listaZaPrikaz.map(z => renderRequestRow(z)).join("");

  const metaCekanje = cekanje.length > 0 ? `${cekanje.length} zahtjeva za obradu` : "";
  wrap.innerHTML = pageHeadingHTML("Na čekanju", metaCekanje) + switcher + `<div class="panel">${statusTabsHTML}${rowsHTML}</div>`;
}

function renderRequestRow(z) {
  const parsedNote = parseNote(z.note);
  const isTelefon  = z.email === "—";

  // Parse date/time from date string
  const dt = parseDateTime(z.date);
  const whenDate = dt ? `${dt.dan}.${String(dt.mjes).padStart(2,"0")}.${dt.god}.` : esc(z.date);
  const whenTime = dt ? dt.vrijeme : "";

  const isHistory = z.status !== "na_cekanju";
  const whenClass = isHistory ? "when when--muted" : "when";

  let actionsHTML = "";
  if (z.status === "na_cekanju") {
    actionsHTML = `
      <div class="req-actions">
        <div class="req-btn-group">
          <button class="btn-odbij" onclick="toggleOdbijForm(${z.id})">Odbij</button>
          <button class="btn-prihvati" onclick="potvrdi(${z.id})">Potvrdi</button>
        </div>
        <div class="reject-form" id="reject-form-${z.id}">
          <textarea class="reject-textarea" id="reject-reason-${z.id}"
                    placeholder="Razlog odbijanja (opcionalno)…" rows="3"></textarea>
          <button class="reject-submit" onclick="submitOdbijanje(${z.id})">Potvrdi odbijanje</button>
        </div>
      </div>`;
  } else if (z.status === "potvrdjeno") {
    actionsHTML = `
      <div class="req-actions">
        <button class="btn-otkazi-termin" onclick="otkazi(${z.id})">Otkaži</button>
      </div>`;
  } else {
    const badgeMap = { odbijeno: "badge-odbijeno", otkazano: "badge-otkazano", predlozeno: "badge-potvrdjeno" };
    const labelMap = { odbijeno: "Odbijeno", otkazano: "Otkazano", predlozeno: "Predloženo" };
    actionsHTML = `
      <div class="req-status-meta">
        <div class="req-status-label">
          <span class="status-badge ${badgeMap[z.status] || ""}">${labelMap[z.status] || esc(z.status)}</span>
        </div>
        <div>${esc(z.primljeno)}</div>
      </div>`;
  }

  const noteHTML = parsedNote.text
    ? `<div class="req-note"><span class="req-note-label">Napomena:</span>${esc(parsedNote.text)}</div>`
    : "";

  return `
    <div class="request-row${isHistory ? " is-muted" : ""}">
      <div class="${whenClass}">
        <div class="when-date">${whenDate}</div>
        ${whenTime ? `<div class="when-time">${whenTime}</div>` : ""}
      </div>
      <div class="req-info">
        <div class="req-name-row">
          <span class="req-name">${esc(z.name)}</span>
          ${isTelefon ? `<span class="req-source req-source--telefon">Telefon</span>` : ""}
          ${!isTelefon ? `<span class="req-contact">${esc(z.email)}</span>` : ""}
        </div>
        <span class="req-service">${esc(z.service)}</span>
        ${parsedNote.phone ? `<div class="req-field"><strong>Tel:</strong> ${esc(parsedNote.phone)}</div>` : ""}
        ${noteHTML}
      </div>
      ${actionsHTML}
    </div>`;
}

// ── Akcije zahtjeva ───────────────────────────────────────────────────────────

function toggleOdbijForm(id) {
  const form = document.getElementById(`reject-form-${id}`);
  if (!form) return;
  form.classList.toggle("is-open");
  if (form.classList.contains("is-open"))
    document.getElementById(`reject-reason-${id}`)?.focus();
}

async function submitOdbijanje(id) {
  const reason = document.getElementById(`reject-reason-${id}`)?.value.trim() || "";

  const res = await adminPost("/admin-odbij", { id, reason });
  const data = await res.json();

  if (data.ok) { await ucitajZahtjeve(); }
  else alert("Greška pri odbijanju.");
}

async function potvrdi(id) {
  const zahtjev = sviZahtjevi.find(z => z.id == id);
  if (!zahtjev) return;

  const res = await adminPost("/admin-action", { id, akcija: "potvrdi", termin: zahtjev.date });
  const data = await res.json();

  if (data.ok) { alert("Potvrda poslana pacijentu!"); ucitajZahtjeve(); }
  else if (res.status === 409) { alert(data.error || "Taj termin je već zauzet."); ucitajZahtjeve(); }
  else alert("Greška pri slanju potvrde.");
}

async function otkazi(id) {
  if (!confirm("Sigurno otkazati termin? Pacijent će biti obaviješten mailom.")) return;

  const res = await adminPost("/admin-cancel", { id });
  const data = await res.json();

  if (data.ok) { alert("Termin je otkazan."); ucitajZahtjeve(); }
  else alert("Greška pri otkazivanju.");
}

// ── Kalendar ─────────────────────────────────────────────────────────────────

async function ucitajKalendar() {
  try {
    const dr = kalDrIdx >= 0 ? sviDoktori[kalDrIdx] : null;
    const drParam = dr ? `?doctorId=${encodeURIComponent(dr.id)}` : "";
    const res = await fetch(`/admin-kalendar/${clientId}${drParam}`);
    kalendarData = await res.json();
  } catch { kalendarData = {}; }
  const danas = new Date();
  if (kalendarGodina === null) kalendarGodina = danas.getFullYear();
  if (kalendarMjesec === null) kalendarMjesec  = danas.getMonth();
  prikaziKalendar();
}

function promijeniKalendarDr(idx) {
  if (kalDrIdx === idx) return;
  kalDrIdx = idx;
  odabraniDanKey = null;
  ucitajKalendar();
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

  // Doctor filter tabs (segmented control)
  const drTabsHTML = sviDoktori.length > 0 ? `
    <div class="filter-bar-left" style="gap:14px;">
      <span class="filter-label">DOKTOR</span>
      <div class="seg-ctrl">
        <button class="seg-btn${kalDrIdx === -1 ? " is-active" : ""}" onclick="promijeniKalendarDr(-1)">Svi</button>
        ${sviDoktori.map((dr, i) => `<button class="seg-btn${kalDrIdx === i ? " is-active" : ""}" onclick="promijeniKalendarDr(${i})">${esc(dr.name)}</button>`).join("")}
      </div>
    </div>` : `<div></div>`;

  const headerHTML = ["PON","UTO","SRI","ČET","PET","SUB","NED"]
    .map(d => `<div class="kal-header-dan">${d}</div>`).join("");

  const prazneHTML = Array(pocetakOffset)
    .fill(`<div class="kal-dan kal-prazan"></div>`).join("");

  let daniHTML = "";
  for (let d = 1; d <= zadnjiDan.getDate(); d++) {
    const key    = isoKey(new Date(kalendarGodina, kalendarMjesec, d));
    const dow    = new Date(kalendarGodina, kalendarMjesec, d).getDay();
    const jeVik  = dow === 0 || dow === 6;
    const jeOdb  = key === odabraniDanKey;
    const jeDan  = key === danasKey;
    const count  = (kalendarData[key] || []).length;

    let kl = "kal-dan";
    if (jeOdb)          kl += " kal-odabran";
    if (jeDan)          kl += " kal-danas";
    if (jeVik && !jeDan && !jeOdb) kl += " kal-vikend";

    daniHTML += `
      <div class="${kl}" onclick="odaberiDan('${key}')">
        <span class="kal-dan-num">${d}</span>
        ${count > 0 ? `<div class="kal-count">${count}<span class="kal-count-label"> termina</span></div>` : ""}
      </div>`;
  }

  const detailHTML = odabraniDanKey ? napraviTermine(odabraniDanKey) : "";

  wrap.innerHTML = pageHeadingHTML("Kalendar") + `
    <div class="panel kal-container">
      <div class="filter-bar" style="justify-content:space-between;">
        ${drTabsHTML}
        <div class="filter-bar-right">
          <button class="kal-nav-btn" onclick="mijenjajMjesec(-1)"><img src="/icons/chevron-left.svg" alt=""></button>
          <span class="kal-mjes">${esc(MJES_NAZIVI[kalendarMjesec])} ${kalendarGodina}.</span>
          <button class="kal-nav-btn" onclick="mijenjajMjesec(1)"><img src="/icons/chevron-right.svg" alt=""></button>
        </div>
      </div>
      <div class="kal-grid">
        ${headerHTML}${prazneHTML}${daniHTML}
      </div>
    </div>
    ${detailHTML}`;
}

function idiNaDanas() {
  const danas = new Date();
  kalendarGodina = danas.getFullYear();
  kalendarMjesec = danas.getMonth();
  odabraniDanKey = null;
  prikaziKalendar();
}

function napraviTermine(dateKey) {
  const termini = (kalendarData[dateKey] || []).sort((a, b) => a.time.localeCompare(b.time));
  const [g, mj, d] = dateKey.split("-");
  const danTjedna = new Date(parseInt(g), parseInt(mj)-1, parseInt(d)).getDay();
  const danNazivi = ["Nedjelja","Ponedjeljak","Utorak","Srijeda","Četvrtak","Petak","Subota"];
  const hrDatum = `${danNazivi[danTjedna]}, ${parseInt(d)}.${parseInt(mj)}.${g}.`;

  if (termini.length === 0) {
    return `<div class="kal-detail-panel"><div class="kal-empty-state">Nema potvrđenih termina za ${hrDatum}</div></div>`;
  }

  const rowsHTML = termini.map(t => {
    const drNaziv = sviDoktori.find(dr => dr.id === t.doctorId)?.name || "";
    const { phone } = parseNote(t.note || "");
    const emailPrikaz = t.email && t.email !== "—" ? t.email : null;
    return `
      <div class="termin-row">
        <div class="termin-time">${esc(t.time)}</div>
        <div class="termin-info">
          <div class="termin-name">${esc(t.name)}</div>
          <div class="termin-meta">
            <span>${esc(t.service)}</span>
            ${drNaziv ? `<span class="termin-meta-dot">·</span>${esc(drNaziv)}` : ""}
            ${emailPrikaz ? `<span class="termin-meta-dot">·</span>${esc(emailPrikaz)}` : ""}
            ${phone ? `<span class="termin-meta-dot">·</span>${esc(phone)}` : ""}
          </div>
        </div>
        <button class="btn-otkazi-mali" onclick="otkazi(${t.id})">Otkaži termin</button>
      </div>`;
  }).join("");

  return `
    <div class="kal-detail-panel">
      <div class="panel-head panel-head--padded">
        <h3 class="panel-title">Termini — ${hrDatum}</h3>
        <span class="panel-meta-inline">${termini.length} zakazanih termina</span>
      </div>
      ${rowsHTML}
    </div>`;
}

// ── Radno vrijeme ─────────────────────────────────────────────────────────────

async function ucitajRasporedTab() {
  if (sviDoktori.length === 0) {
    wrap.innerHTML = `<div class="prazno">Ova ordinacija nema definiranih doktora.</div>`;
    return;
  }
  const doktor = sviDoktori[rvDoktorIdx];
  const [rasporedRes] = await Promise.all([
    fetch(`/admin-raspored/${clientId}?doctorId=${encodeURIComponent(doktor.id)}`).then(r => r.json()),
    ucitajRvIznimke(doktor.id),
  ]);
  rvSchedule  = rasporedRes.schedule  || {};
  rvScheduleB = rasporedRes.scheduleB || {};
  rvAlternativni = Object.keys(rvScheduleB).length > 0;
  rvNeradniDani = new Set();
  for (const day of [1,2,3,4,5,6,0]) {
    if (!rvSchedule[String(day)]?.startTime)  rvNeradniDani.add(`rv-${day}`);
    if (!rvScheduleB[String(day)]?.startTime) rvNeradniDani.add(`rvb-${day}`);
  }
  renderRasporedView(doktor);
}

async function ucitajRvIznimke(doctorId) {
  const res = await fetch(
    `/admin-iznimke/${clientId}?doctorId=${encodeURIComponent(doctorId)}&year=${rvGodina}&month=${rvMjesec+1}`
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

function toggleAlternativni(val) {
  rvAlternativni = val;
  if (val && Object.keys(rvScheduleB).length === 0) {
    // Prvi put — kopiraj tjedan A kao polaznu točku
    rvScheduleB = JSON.parse(JSON.stringify(rvSchedule));
    // Rvb neradan = isti kao rv neradan
    for (const day of [1,2,3,4,5,6,0]) {
      if (rvNeradniDani.has(`rv-${day}`)) {
        rvNeradniDani.add(`rvb-${day}`);
      } else {
        rvNeradniDani.delete(`rvb-${day}`);
      }
    }
  }
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

function readRvTime(prefix, type, day) {
  if (rvNeradniDani.has(`${prefix}-${day}`)) return "";
  return document.getElementById(`${prefix}-${type}-${day}`)?.value || "";
}

function toggleNeradanDan(prefix, day, neradan) {
  const key = `${prefix}-${day}`;
  if (neradan) rvNeradniDani.add(key); else rvNeradniDani.delete(key);
  const td = document.getElementById(`${prefix}-td-${day}`);
  if (!td) return;
  td.classList.toggle("rv-td-neradan", neradan);
  td.querySelectorAll("input.rv-time-input").forEach(inp => inp.disabled = neradan);
}

function applyPonToAll(prefix) {
  const startVal = document.getElementById(`${prefix}-start-1`)?.value;
  const endVal   = document.getElementById(`${prefix}-end-1`)?.value;
  for (const day of [2,3,4,5,6,0]) {
    if (rvNeradniDani.has(`${prefix}-${day}`)) {
      const cb = document.getElementById(`${prefix}-neradan-${day}`);
      if (cb) cb.checked = false;
      toggleNeradanDan(prefix, day, false);
    }
    const sInp = document.getElementById(`${prefix}-start-${day}`); if (sInp) sInp.value = startVal;
    const eInp = document.getElementById(`${prefix}-end-${day}`);   if (eInp) eInp.value = endVal;
  }
}

async function spremiRaspored() {
  const doktor = sviDoktori[rvDoktorIdx];
  const schedule  = {};
  const scheduleB = {};
  const ORDEN = [1,2,3,4,5,6,0];
  for (const day of ORDEN) {
    const start = readRvTime("rv", "start", day);
    const end   = readRvTime("rv", "end",   day);
    if (start && end) schedule[String(day)] = { startTime: start, endTime: end };
  }
  if (rvAlternativni) {
    for (const day of ORDEN) {
      const start = readRvTime("rvb", "start", day);
      const end   = readRvTime("rvb", "end",   day);
      if (start && end) scheduleB[String(day)] = { startTime: start, endTime: end };
    }
  }
  const res = await adminPost("/admin-raspored", { doctorId: doktor.id, schedule, scheduleB });
  const data = await res.json();
  if (data.ok) {
    const poruka = data.otkazano > 0
      ? `Raspored spremljen.\n\nAutomatski otkazano ${data.otkazano} termina koji ne odgovaraju novom rasporedu. Pacijenti su obaviješteni.`
      : "Raspored spremljen.";
    alert(poruka);
    rvSchedule  = schedule;
    rvScheduleB = rvAlternativni ? scheduleB : rvScheduleB;
    renderRasporedView(doktor);
  } else {
    alert("Greška pri spremanju.");
  }
}

async function blokirajDan(doctorId, date) {
  const res = await adminPost("/admin-iznimka", { doctorId, date, type: "block_day" });
  if ((await res.json()).ok) { await ucitajRvIznimke(doctorId); renderRasporedView(sviDoktori[rvDoktorIdx]); }
}

async function ukloniBlokadeDana(doctorId, date) {
  for (const b of (rvIznimke[date] || []).filter(i => i.type === "block_day")) {
    await adminPost("/admin-iznimka-delete", { id: b.id });
  }
  await ucitajRvIznimke(doctorId);
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

async function toggleSlotBlokada(doctorId, date, time) {
  const iznimkeKey = rvIznimke[date] || [];
  const existing = iznimkeKey.find(i => i.type === "block_slot" && i.time === time);
  if (existing) {
    await adminPost("/admin-iznimka-delete", { id: existing.id });
  } else {
    await adminPost("/admin-iznimka", { doctorId, date, type: "block_slot", time });
  }
  await ucitajRvIznimke(doctorId);
  renderRasporedView(sviDoktori[rvDoktorIdx]);
}

function renderRasporedView(doktor) {
  const DANI_KRATKI = ["Ned","Pon","Uto","Sri","Čet","Pet","Sub"];
  const ORDEN = [1,2,3,4,5,6,0]; // Pon→Ned

  // Doktor segmented tabs
  const drTabsHTML = sviDoktori.length > 1 ? `
    <div class="filter-bar-left" style="gap:14px;">
      <span class="filter-label">DOKTOR</span>
      <div class="seg-ctrl">
        ${sviDoktori.map((dr, i) => `<button class="seg-btn${rvDoktorIdx === i ? " is-active" : ""}" onclick="promijeniRvDoktorTab(${i})">${esc(dr.name)}</button>`).join("")}
      </div>
    </div>` : `<div class="filter-bar-left"><span style="font-size:13px;font-weight:600;">${esc(doktor.name)}</span></div>`;

  function buildTable(prefix, sched) {
    const thead = ORDEN.map(day => {
      const neradan = rvNeradniDani.has(`${prefix}-${day}`);
      return `<th class="rv-th">
        <div class="rv-th-name">${DANI_KRATKI[day]}</div>
        <label class="rv-neradan-label">
          <input type="checkbox" id="${prefix}-neradan-${day}" class="rv-neradan-cb"
                 ${neradan ? "checked" : ""} onchange="toggleNeradanDan('${prefix}',${day},this.checked)">
          <span>neradan</span>
        </label>
      </th>`;
    }).join("");

    const tbody = ORDEN.map(day => {
      const neradan = rvNeradniDani.has(`${prefix}-${day}`);
      const entry   = sched[String(day)];
      const dis     = neradan ? "disabled" : "";
      const applyBtn = day === 1
        ? `<button class="rv-apply-all-btn" onclick="applyPonToAll('${prefix}')">Primjeni na sve</button>`
        : "";
      return `
        <td class="rv-td${neradan ? " rv-td-neradan" : ""}" id="${prefix}-td-${day}">
          <div class="rv-time-group">
            <input class="rv-time-input" type="time"
                   id="${prefix}-start-${day}" value="${entry?.startTime || ""}" ${dis}>
          </div>
          <div class="rv-time-group">
            <input class="rv-time-input" type="time"
                   id="${prefix}-end-${day}" value="${entry?.endTime || ""}" ${dis}>
          </div>
          ${applyBtn}
        </td>`;
    }).join("");

    return `
      <div class="rv-tablica-wrap">
        <table class="rv-tablica">
          <thead><tr>${thead}</tr></thead>
          <tbody><tr>${tbody}</tr></tbody>
        </table>
      </div>`;
  }

  const altSection = rvAlternativni ? `
    <div class="rv-alt-section">
      <div class="rv-alt-section-label">Tjedan B</div>
      ${buildTable("rvb", rvScheduleB)}
    </div>` : "";

  wrap.innerHTML = pageHeadingHTML("Radno vrijeme", "Definirajte radne sate po doktoru i danu") + `
    <div class="panel rv-panel">
      <div class="filter-bar" style="justify-content:space-between;">
        ${drTabsHTML}
      </div>
      ${buildTable("rv", rvSchedule)}
      ${altSection}
      <div class="rv-alt-wrap">
        <input type="checkbox" class="rv-alt-switch" id="rv-alt-switch"
               ${rvAlternativni ? "checked" : ""} onchange="toggleAlternativni(this.checked)">
        <label for="rv-alt-switch" class="rv-alt-label">Naizmjenični tjedni (A/B raspored)</label>
      </div>
      <div class="rv-footer">
        <button class="rv-spremi-btn" onclick="spremiRaspored()">Spremi raspored</button>
      </div>
    </div>`;
}

function promijeniRvDoktorTab(idx) {
  rvDoktorIdx = idx;
  ucitajRasporedTab();
}

// ── Telefon tab ───────────────────────────────────────────────────────────────

function renderTelefonTab() {
  const serviceOpts = (window._clientServices || []).map(s => ({ value: s, label: s }));
  const imaDoktora  = sviDoktori.length > 0;
  const doctorOpts  = sviDoktori.map(d => ({ value: d.id, label: d.name }));
  const terminGrid  = imaDoktora ? "tel-grid-4" : "tel-grid-3";
  const danas       = _dpToday();

  const doktorCell = imaDoktora
    ? `<div><label class="tel-label">Doktor</label>${buildCsHTML("tel-doktor", sviDoktori[0]?.id || "", doctorOpts, "Odaberi doktora")}</div>`
    : `<input type="hidden" id="tel-doktor" value="">`;

  wrap.innerHTML = pageHeadingHTML("Unos s telefona") + `
    <div class="panel tel-panel">
      <div class="panel-head panel-head--padded">
        <span class="panel-title">Novi termin</span>
        <span class="panel-meta">Pacijent ne dobiva potvrdu e-mailom ako email nije unesen.</span>
      </div>

      <div class="tel-body">
        <div class="tel-section">
          <div class="tel-section-label">Pacijent</div>
          <div class="tel-grid-3">
            <div>
              <label class="tel-label">Ime i prezime</label>
              <input type="text" class="tel-input" id="tel-ime" placeholder="npr. Ana Kovač">
            </div>
            <div>
              <label class="tel-label">Telefon (opcionalno)</label>
              <input type="text" class="tel-input" id="tel-telefon" placeholder="091 234 5678">
            </div>
            <div>
              <label class="tel-label">Email (opcionalno)</label>
              <input type="email" class="tel-input" id="tel-email" placeholder="ime@mail.com">
            </div>
          </div>
        </div>

        <div class="tel-section">
          <div class="tel-section-label">Termin</div>
          <div class="${terminGrid}">
            ${doktorCell}
            <div>
              <label class="tel-label">Datum</label>
              ${buildDpHTML("tel-datum", danas, danas, "Odaberi datum")}
            </div>
            <div>
              <label class="tel-label">Slobodan termin</label>
              <div id="tel-termin-wrap"></div>
            </div>
            <div>
              <label class="tel-label">Usluga</label>
              ${buildCsHTML("tel-usluga", serviceOpts[0]?.value || "", serviceOpts, "Odaberi uslugu")}
            </div>
          </div>
        </div>

        <div class="tel-section">
          <div class="tel-section-label">Napomena (opcionalno)</div>
          <textarea class="tel-textarea" id="tel-napomena" placeholder="Razlog dolaska, dijagnoza, alergije…"></textarea>
        </div>
      </div>

      <div class="tel-footer">
        <div class="tel-status" id="tel-status"></div>
        <button class="tel-submit" onclick="submitTelefonBooking()">Upiši termin</button>
      </div>
    </div>`;

  ucitajTelefonTermine();
}

async function ucitajTelefonTermine() {
  const datum  = document.getElementById("tel-datum")?.value;
  const drId   = document.getElementById("tel-doktor")?.value || "";
  const wrapEl = document.getElementById("tel-termin-wrap");
  if (!datum || !wrapEl) return;

  wrapEl.innerHTML = `<input type="hidden" id="tel-termin" value=""><div class="cs-wrap"><button type="button" class="cs-trigger" disabled style="opacity:0.6;cursor:default"><span class="cs-value cs-placeholder">Učitavam…</span></button></div>`;
  try {
    const drParam = drId ? `?doctorId=${encodeURIComponent(drId)}` : "";
    const res     = await fetch(`/termini/${clientId}/${datum}${drParam}`);
    const podaci  = res.ok ? await res.json() : {};
    const zauzeti    = podaci.zauzeti || [];
    const raspon     = podaci.radnoVrijeme || null;
    const sviTermini = raspon ? generirajTermine(raspon) : [];
    const slobodni   = sviTermini.filter(t => !zauzeti.includes(t));
    if (slobodni.length === 0) {
      wrapEl.innerHTML = `<input type="hidden" id="tel-termin" value=""><div class="cs-wrap"><button type="button" class="cs-trigger" disabled style="opacity:0.6;cursor:default"><span class="cs-value cs-placeholder">Nema slobodnih termina</span></button></div>`;
    } else {
      const opts = slobodni.map(t => ({ value: t, label: t }));
      wrapEl.innerHTML = buildCsHTML("tel-termin", slobodni[0], opts, "Odaberi termin");
    }
  } catch {
    wrapEl.innerHTML = `<input type="hidden" id="tel-termin" value=""><div class="cs-wrap"><button type="button" class="cs-trigger" disabled style="opacity:0.6;cursor:default"><span class="cs-value cs-placeholder">Greška pri učitavanju</span></button></div>`;
  }
}

async function submitTelefonBooking() {
  const datum    = document.getElementById("tel-datum")?.value;
  const termin   = document.getElementById("tel-termin")?.value;
  const ime      = document.getElementById("tel-ime")?.value.trim();
  const usluga   = document.getElementById("tel-usluga")?.value;
  const drId     = document.getElementById("tel-doktor")?.value || "";
  const tel      = document.getElementById("tel-telefon")?.value.trim();
  const email    = document.getElementById("tel-email")?.value.trim();
  const napomena = document.getElementById("tel-napomena")?.value.trim();
  const statusEl = document.getElementById("tel-status");

  statusEl.className = "tel-status";
  statusEl.textContent = "";

  if (!datum || !termin || !ime || !usluga) {
    statusEl.className = "tel-status error";
    statusEl.textContent = "Popunite sva obavezna polja.";
    return;
  }

  const [g, mj, d] = datum.split("-");
  const datumHR = `${d}.${mj}.${g}. u ${termin}`;

  const submitBtn = document.querySelector(".tel-submit");
  submitBtn.disabled = true;

  try {
    const res = await adminPost("/admin-phone-booking", {
      doctorId: drId, date: datumHR,
      name: ime, service: usluga,
      email: email || "—",
      note: [tel ? `Tel: ${tel}` : "", napomena].filter(Boolean).join(" | ") || "—",
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.className = "tel-status ok";
      statusEl.textContent = `✓ Termin upisan: ${ime}, ${datumHR}`;
      document.getElementById("tel-ime").value = "";
      document.getElementById("tel-telefon").value = "";
      document.getElementById("tel-email").value = "";
      document.getElementById("tel-napomena").value = "";
      await ucitajTelefonTermine();
    } else {
      statusEl.className = "tel-status error";
      statusEl.textContent = data.error || "Greška pri upisu termina.";
    }
  } catch {
    statusEl.className = "tel-status error";
    statusEl.textContent = "Greška pri spajanju na server.";
  } finally {
    submitBtn.disabled = false;
  }
}

// ── Postavke: doktori i usluge ────────────────────────────────────────────

let postavkeData = { doctors: [], services: [] };

async function ucitajPostavke() {
  try {
    const res = await fetch(`/admin-postavke/${clientId}`);
    if (!res.ok) throw new Error();
    postavkeData = await res.json();
    sviDoktori = postavkeData.doctors || [];
    window._clientServices = (postavkeData.services || []).map(s => s.name);
  } catch {
    postavkeData = { doctors: [], services: [] };
  }
  renderPostavkeView();
}

function renderPostavkeView() {
  const { doctors, services } = postavkeData;

  const drListHTML = doctors.length === 0
    ? `<div class="post-empty">Nema dodanih doktora.</div>`
    : doctors.map((d, i) => `
        <div class="post-item">
          <span class="post-item-name">${esc(d.name)}</span>
          <button class="post-item-del" onclick="obrisiDoktora(${i})" title="Obriši">×</button>
        </div>`).join("");

  const svcListHTML = services.length === 0
    ? `<div class="post-empty">Nema dodanih usluga.</div>`
    : services.map((s, i) => `
        <div class="post-item">
          <span class="post-item-name">${esc(s.name)}</span>
          <span class="post-item-badge">${s.duration} min</span>
          <button class="post-item-del" onclick="obrisiUslugu(${i})" title="Obriši">×</button>
        </div>`).join("");

  wrap.innerHTML = pageHeadingHTML("Postavke") + `
    <div class="panel post-panel">
      <div class="filter-bar">
        <span class="panel-title">Doktori</span>
      </div>
      <div>${drListHTML}</div>
      <div id="post-dr-status" class="post-status"></div>
      <div class="post-add-form">
        <input class="post-input" type="text" id="post-dr-ime"
               placeholder="Ime i prezime doktora…" maxlength="100"
               onkeydown="if(event.key==='Enter') dodajDoktora()">
        <button class="post-add-btn" onclick="dodajDoktora()">+ Dodaj</button>
      </div>
    </div>

    <div class="panel post-panel">
      <div class="filter-bar">
        <span class="panel-title">Usluge</span>
      </div>
      <div>${svcListHTML}</div>
      <div id="post-svc-status" class="post-status"></div>
      <div class="post-add-form">
        <input class="post-input" type="text" id="post-svc-ime"
               placeholder="Naziv usluge…" maxlength="100"
               onkeydown="if(event.key==='Enter') dodajUslugu()">
        <select class="post-select" id="post-svc-dur">
          <option value="15">15 min</option>
          <option value="30" selected>30 min</option>
          <option value="45">45 min</option>
          <option value="60">60 min</option>
          <option value="90">90 min</option>
          <option value="120">120 min</option>
        </select>
        <button class="post-add-btn" onclick="dodajUslugu()">+ Dodaj</button>
      </div>
    </div>`;
}

async function dodajDoktora() {
  const ime = document.getElementById("post-dr-ime")?.value.trim();
  const statusEl = document.getElementById("post-dr-status");
  if (!ime) { if (statusEl) statusEl.textContent = "Unesite ime doktora."; return; }
  if (statusEl) statusEl.textContent = "";

  const res = await adminPost("/admin-dodaj-doktora", { name: ime });
  const data = await res.json();
  if (data.ok) {
    await ucitajPostavke();
  } else {
    if (statusEl) statusEl.textContent = data.error || "Greška pri dodavanju.";
  }
}

async function obrisiDoktora(idx) {
  const d = postavkeData.doctors[idx];
  if (!d) return;
  if (!confirm(`Obrisati doktora "${d.name}"?\n\nRaspored i termini vezani uz ovog doktora neće biti obrisani.`)) return;

  const res = await adminPost("/admin-obrisi-doktora", { doctorId: d.id });
  const data = await res.json();
  if (data.ok) {
    await ucitajPostavke();
  } else {
    alert(data.error || "Greška pri brisanju.");
  }
}

async function dodajUslugu() {
  const ime = document.getElementById("post-svc-ime")?.value.trim();
  const dur = parseInt(document.getElementById("post-svc-dur")?.value || "30", 10);
  const statusEl = document.getElementById("post-svc-status");
  if (!ime) { if (statusEl) statusEl.textContent = "Unesite naziv usluge."; return; }
  if (statusEl) statusEl.textContent = "";

  const res = await adminPost("/admin-dodaj-uslugu", { name: ime, duration: dur });
  const data = await res.json();
  if (data.ok) {
    await ucitajPostavke();
  } else {
    if (statusEl) statusEl.textContent = data.error || "Greška pri dodavanju.";
  }
}

async function obrisiUslugu(idx) {
  const s = postavkeData.services[idx];
  if (!s) return;
  if (!confirm(`Obrisati uslugu "${s.name}"?`)) return;

  const res = await adminPost("/admin-obrisi-uslugu", { name: s.name });
  const data = await res.json();
  if (data.ok) {
    await ucitajPostavke();
  } else {
    alert(data.error || "Greška pri brisanju.");
  }
}

// ── Odjava ───────────────────────────────────────────────────────────────────

async function odjava() {
  await fetch("/admin-logout", { method: "POST" }).catch(() => {});
  window.location.href = "/admin";
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function ucitajZahtjeve() {
  // Dohvati CSRF token za ovu sesiju (potreban za sve POST zahtjeve)
  const csrfRes = await fetch("/admin-csrf");
  if (csrfRes.ok) {
    const csrfData = await csrfRes.json();
    _csrfToken = csrfData.csrfToken || "";
  }

  const dataRes = await fetch(`/admin-data/${clientId}`);

  if (dataRes.status === 403) {
    window.location.href = "/admin";
    return;
  }

  const data = await dataRes.json();

  try {
    const cfgRes = await fetch(`/config/${clientId}`);
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      window._clientServices = (cfg.services || []).map(s => s.name);
    }
  } catch { /* ignoriraj */ }

  title.textContent = "Na čekanju";
  sviZahtjevi = data.zahtjevi;
  sviDoktori  = data.doctors || [];

  const sidebarBrand = document.getElementById("sidebarBrand");
  if (sidebarBrand) sidebarBrand.textContent = data.brandName;
  const topbarOrdinacija = document.getElementById("topbarOrdinacija");
  if (topbarOrdinacija) topbarOrdinacija.textContent = data.brandName;

  prikaziZahtjeve();
}

ucitajZahtjeve();

document.getElementById("nav-cekanje").addEventListener("click", () => promijeniTab("cekanje"));
document.getElementById("nav-kalendar").addEventListener("click", () => promijeniTab("kalendar"));
document.getElementById("nav-radno-vrijeme").addEventListener("click", () => promijeniTab("radno-vrijeme"));
document.getElementById("nav-telefon").addEventListener("click", () => promijeniTab("telefon"));
document.getElementById("nav-postavke").addEventListener("click", () => promijeniTab("postavke"));
document.getElementById("odjavaBtn").addEventListener("click", odjava);

document.addEventListener("mousedown", function(e) {
  if (!e.target.closest(".cs-wrap")) {
    document.querySelectorAll(".cs-wrap.is-open").forEach(w => w.classList.remove("is-open"));
  }
});
