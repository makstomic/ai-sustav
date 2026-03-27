const dijelovi = window.location.pathname.split("/");
const clientId = dijelovi[2];
const adminToken = dijelovi[3];
const wrap = document.getElementById("zahtjevi");
const title = document.getElementById("adminTitle");

let sviZahtjevi = [];
let aktivniTab = "cekanje";

// ── Tabovi ──
function napraviTabove() {
  const tabWrap = document.createElement("div");
  tabWrap.style.cssText = "display:flex; gap:8px; max-width:900px; margin:0 auto 20px; padding:0 16px;";
  tabWrap.innerHTML = `
    <button id="tab-cekanje" onclick="promijeniTab('cekanje')" style="flex:1; padding:11px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; border:1.5px solid var(--accent); background:var(--accent); color:#fff; font-family:var(--font);">Na čekanju</button>
    <button id="tab-povijest" onclick="promijeniTab('povijest')" style="flex:1; padding:11px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; border:1.5px solid var(--accent); background:transparent; color:var(--accent); font-family:var(--font);">Povijest</button>
  `;
  document.getElementById("adminTitle").after(tabWrap);
}

function promijeniTab(tab) {
  aktivniTab = tab;

  const btnCekanje  = document.getElementById("tab-cekanje");
  const btnPovijest = document.getElementById("tab-povijest");

  if (tab === "cekanje") {
    btnCekanje.style.background  = "var(--accent)";
    btnCekanje.style.color       = "#fff";
    btnPovijest.style.background = "transparent";
    btnPovijest.style.color      = "var(--accent)";
  } else {
    btnPovijest.style.background = "var(--accent)";
    btnPovijest.style.color      = "#fff";
    btnCekanje.style.background  = "transparent";
    btnCekanje.style.color       = "var(--accent)";
  }

  prikaziZahtjeve();
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

// ── Prikaz ──
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

// ── Init ──
async function ucitajZahtjeve() {
  const res  = await fetch(`/admin-data/${clientId}?token=${adminToken}`);
  const data = await res.json();

  title.textContent = `Admin — ${data.brandName}`;
  sviZahtjevi = data.zahtjevi;

  prikaziZahtjeve();
}

napraviTabove();
ucitajZahtjeve();