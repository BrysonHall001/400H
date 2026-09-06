/* app.js — 400H unit tracker */

const state = {
  plans: [],            // static metadata
  planHistory: [],      // rows {date, plan, status, total_min, ...}
  unitHistory: [],      // snapshots [{date, source, units:[...]}]
  bedsOn: new Set([1]),
  plansOn: new Set(),   // plan codes explicitly toggled; empty = all within beds filter
  sort: { key: "unit", dir: 1 },
  planChart: null,
  unitChart: null,
  dirty: false,         // imported data not yet saved to file
};

/* Green/champagne ramp; falls back to generated hues past its length. */
const PALETTE = ["#2f6b4f", "#bfa05e", "#4e8a76", "#8a6d2f", "#1f3d33",
                 "#a4b06a", "#6fa28e", "#5b4a1e", "#3e5c53", "#d0b98a"];
const colorFor = (i) => PALETTE[i % PALETTE.length] ||
  `hsl(${(i * 47) % 360} 35% 40%)`;

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => n === null || n === undefined ? "—" : "$" + n.toLocaleString("en-US");

/* ---------------- data loading ---------------- */

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const CACHE_KEY = "400h-unit-history-cache";

async function boot() {
  const [plans, planHist, unitHist] = await Promise.all([
    loadJSON("data/plans.json"),
    loadJSON("data/plan-history.json"),
    loadJSON("data/unit-history.json"),
  ]);
  state.plans = plans.plans;
  state.planHistory = planHist.history;
  state.unitHistory = unitHist.snapshots;

  // Merge any imports cached before they were saved to the repo file.
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    for (const snap of cached) {
      if (!state.unitHistory.some(s => s.date === snap.date)) {
        state.unitHistory.push(snap);
        state.dirty = true;
      }
    }
    state.unitHistory.sort((a, b) => a.date.localeCompare(b.date));
  } catch (_) { /* cache unreadable — ignore */ }

  buildPlanChips();
  renderAll();
  if (state.dirty) {
    showStatus("Restored an imported snapshot from this browser's cache — save it to data/unit-history.json to make it permanent.", false);
    $("#download-unit-history").hidden = false;
  }
}

/* ---------------- tabs ---------------- */

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", b === btn);
    });
    document.querySelectorAll(".panel").forEach(p => p.hidden = true);
    $("#panel-" + btn.dataset.tab).hidden = false;
  });
});

/* ---------------- filters ---------------- */

function buildPlanChips() {
  const row = $("#plan-filter");
  row.innerHTML = "";
  state.plans.forEach(p => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.code;
    b.dataset.plan = p.code;
    b.dataset.beds = p.beds;
    b.addEventListener("click", () => {
      if (state.plansOn.has(p.code)) state.plansOn.delete(p.code);
      else state.plansOn.add(p.code);
      renderAll();
    });
    row.appendChild(b);
  });
}

document.querySelectorAll("#beds-filter .chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const n = Number(chip.dataset.beds);
    if (state.bedsOn.has(n)) state.bedsOn.delete(n); else state.bedsOn.add(n);
    state.plansOn.clear(); // beds change resets per-plan picks
    renderAll();
  });
});

function visiblePlans() {
  const byBeds = state.plans.filter(p => state.bedsOn.size === 0 || state.bedsOn.has(p.beds));
  if (state.plansOn.size === 0) return byBeds.map(p => p.code);
  return byBeds.filter(p => state.plansOn.has(p.code)).map(p => p.code);
}

function syncChips() {
  document.querySelectorAll("#beds-filter .chip").forEach(c =>
    c.classList.toggle("is-on", state.bedsOn.has(Number(c.dataset.beds))));
  const shown = new Set(visiblePlans());
  document.querySelectorAll("#plan-filter .chip").forEach(c => {
    const inBeds = state.bedsOn.size === 0 || state.bedsOn.has(Number(c.dataset.beds));
    c.style.display = inBeds ? "" : "none";
    c.classList.toggle("is-on", shown.has(c.dataset.plan) && state.plansOn.size > 0);
    c.classList.toggle("is-partial", shown.has(c.dataset.plan) && state.plansOn.size === 0);
  });
}

/* ---------------- plan chart ---------------- */

function renderPlanChart() {
  const dates = [...new Set(state.planHistory.map(r => r.date))].sort();
  const shown = visiblePlans();
  const datasets = [];
  let colorIdx = 0;

  for (const code of shown) {
    const rows = new Map(state.planHistory
      .filter(r => r.plan === code)
      .map(r => [r.date, r]));
    const mins = dates.map(d => rows.get(d)?.status === "priced" ? rows.get(d).total_min : null);
    const maxs = dates.map(d => rows.get(d)?.status === "priced" ? rows.get(d).total_max : null);
    if (mins.every(v => v === null)) { colorIdx++; continue; }
    const color = colorFor(colorIdx++);
    const hasBand = maxs.some((v, i) => v !== null && v !== mins[i]);
    if (hasBand) {
      datasets.push({ label: code + " max", data: maxs, borderColor: color + "55",
        borderDash: [4, 4], borderWidth: 1, pointRadius: 0, spanGaps: true,
        fill: false, legendHide: true });
      datasets.push({ label: code, data: mins, borderColor: color,
        backgroundColor: color + "1f", borderWidth: 2, pointRadius: 3,
        spanGaps: true, fill: "-1" });
    } else {
      datasets.push({ label: code, data: mins, borderColor: color,
        borderWidth: 2, pointRadius: 3, spanGaps: true, fill: false });
    }
  }

  if (state.planChart) state.planChart.destroy();
  state.planChart = new Chart($("#plan-chart"), {
    type: "line",
    data: { labels: dates, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      scales: { y: { ticks: { callback: v => "$" + v.toLocaleString() } } },
      plugins: {
        legend: { labels: { filter: item =>
          !datasets[item.datasetIndex] || !datasets[item.datasetIndex].legendHide } },
        tooltip: { callbacks: { label: ctx =>
          `${ctx.dataset.label}: $${ctx.parsed.y?.toLocaleString()}` } },
      },
    },
  });
}

/* ---------------- unit chart ---------------- */

function unitSeries() {
  const series = new Map(); // unit -> {plan, beds, points: Map(date->price)}
  for (const snap of state.unitHistory) {
    for (const u of snap.units) {
      if (!series.has(u.unit)) series.set(u.unit, { plan: u.plan, beds: u.beds, points: new Map() });
      const price = u.total_price !== null && u.total_price !== undefined ? u.total_price : u.price;
      series.get(u.unit).points.set(snap.date, price);
    }
  }
  return series;
}

function renderUnitChart() {
  const empty = state.unitHistory.length === 0;
  $("#unit-chart-empty").hidden = !empty;
  $("#unit-chart").parentElement.style.display = empty ? "none" : "";
  if (empty) { if (state.unitChart) { state.unitChart.destroy(); state.unitChart = null; } return; }

  const dates = state.unitHistory.map(s => s.date);
  const shownPlans = new Set(visiblePlans());
  const datasets = [];
  let i = 0;
  for (const [unit, s] of unitSeries()) {
    if (s.plan && !shownPlans.has(s.plan)) continue;
    datasets.push({
      label: `${unit} (${s.plan || "?"})`,
      data: dates.map(d => s.points.get(d) ?? null),
      borderColor: colorFor(i++), borderWidth: 2, pointRadius: 3,
      spanGaps: false, fill: false,
    });
  }
  if (state.unitChart) state.unitChart.destroy();
  state.unitChart = new Chart($("#unit-chart"), {
    type: "line",
    data: { labels: dates, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      scales: { y: { ticks: { callback: v => "$" + v.toLocaleString() } } },
    },
  });
}

/* ---------------- units table ---------------- */

document.querySelectorAll("#units-table thead th").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    renderUnitsTable();
  });
});

function renderUnitsTable() {
  const tbody = $("#units-table tbody");
  tbody.innerHTML = "";
  const latest = state.unitHistory[state.unitHistory.length - 1];
  $("#units-empty").hidden = !!latest;
  $("#units-asof").textContent = latest ? `as of ${latest.date} (${latest.source})` : "";
  $("#building-availability-note").textContent = latest
    ? `Latest snapshot: ${latest.units.length} units available as of ${latest.date}.` : "";
  if (!latest) return;

  const rows = [...latest.units].sort((a, b) => {
    const k = state.sort.key;
    const av = a[k] ?? "", bv = b[k] ?? "";
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv : String(av).localeCompare(String(bv));
    return cmp * state.sort.dir;
  });
  for (const u of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.unit}</td><td class="num">${u.floor ?? "—"}</td><td>${u.plan ?? "—"}</td>
      <td class="num">${u.beds ?? "—"}</td><td class="num">${u.sqft?.toLocaleString() ?? "—"}</td>
      <td class="num">${fmt(u.price)}</td><td class="num">${fmt(u.total_price)}</td>
      <td>${u.available_on ?? "—"}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------------- spread analysis ---------------- */

function renderSpread() {
  const tbody = $("#spread-table tbody");
  tbody.innerHTML = "";
  const latest = state.unitHistory[state.unitHistory.length - 1];
  $("#spread-empty").hidden = !!latest;
  if (!latest) return;

  // Plan rows on or before the unit snapshot date (most recent per plan).
  const planRow = new Map();
  for (const r of state.planHistory) {
    if (r.date > latest.date || r.status !== "priced") continue;
    const cur = planRow.get(r.plan);
    if (!cur || r.date > cur.date) planRow.set(r.plan, r);
  }

  // Typical drift: mean |day-over-day change| per unit across all snapshots.
  const drift = new Map();
  for (const [unit, s] of unitSeries()) {
    const prices = [...s.points.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(e => e[1]).filter(p => p !== null && p !== undefined);
    if (prices.length < 2) { drift.set(unit, null); continue; }
    let sum = 0;
    for (let i = 1; i < prices.length; i++) sum += Math.abs(prices[i] - prices[i - 1]);
    drift.set(unit, Math.round(sum / (prices.length - 1)));
  }

  const shownPlans = new Set(visiblePlans());
  for (const u of [...latest.units].sort((a, b) => (a.plan || "").localeCompare(b.plan || "") || a.unit.localeCompare(b.unit))) {
    if (u.plan && !shownPlans.has(u.plan)) continue;
    const pr = u.plan ? planRow.get(u.plan) : null;
    const price = u.total_price ?? u.price;
    const delta = pr && price !== null ? price - pr.total_min : null;
    const d = drift.get(u.unit);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.plan ?? "—"}</td>
      <td>${pr ? `${fmt(pr.total_min)} – ${fmt(pr.total_max)} (${pr.date})` : "not advertised"}</td>
      <td>${u.unit}</td>
      <td class="num">${fmt(price)}</td>
      <td class="num ${delta > 0 ? "delta-pos" : delta < 0 ? "delta-neg" : ""}">
        ${delta === null ? "—" : (delta >= 0 ? "+" : "−") + "$" + Math.abs(delta).toLocaleString()}</td>
      <td class="num">${d === null || d === undefined ? "needs ≥2 days" : "±$" + d.toLocaleString() + "/day"}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------------- import ---------------- */

const drop = $("#drop-zone");
const fileInput = $("#file-input");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.add("is-over");
}));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.remove("is-over");
}));
drop.addEventListener("drop", e => { if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) importFile(fileInput.files[0]); fileInput.value = ""; });

function showStatus(msg, isError) {
  const el = $("#import-status");
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("is-error", !!isError);
}

async function importFile(file) {
  try {
    const text = await file.text();
    const today = new Date().toISOString().slice(0, 10);
    const { snapshot, sightmapUrl } = HAR.parseDrop(text, today);
    if (snapshot.units.length === 0) throw new Error("Feed parsed but contained zero units.");

    const replaced = state.unitHistory.some(s => s.date === snapshot.date);
    state.unitHistory = state.unitHistory.filter(s => s.date !== snapshot.date);
    state.unitHistory.push(snapshot);
    state.unitHistory.sort((a, b) => a.date.localeCompare(b.date));
    state.dirty = true;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.unitHistory)); } catch (_) {}

    let msg = `${replaced ? "Replaced" : "Added"} snapshot for ${snapshot.date}: ${snapshot.units.length} units. ` +
      `Click "Save updated unit-history.json" and commit it to keep this permanently.`;
    if (sightmapUrl) msg += ` SightMap feed URL found (for the daily fetch — see README): ${sightmapUrl}`;
    showStatus(msg, false);
    $("#download-unit-history").hidden = false;
    renderAll();
  } catch (err) {
    showStatus(err.message, true);
  }
}

$("#download-unit-history").addEventListener("click", () => {
  const doc = {
    note: "Per-unit price snapshots from the Engrain SightMap feed (Map tab).",
    snapshots: state.unitHistory,
  };
  const blob = new Blob([JSON.stringify(doc, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "unit-history.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showStatus("Downloaded. Replace data/unit-history.json in the repo with this file and commit.", false);
});

/* ---------------- render ---------------- */

function renderAll() {
  syncChips();
  renderPlanChart();
  renderUnitChart();
  renderUnitsTable();
  renderSpread();
}

boot().catch(err => {
  document.body.insertAdjacentHTML("beforeend",
    `<div class="import-status is-error" style="margin:20px 28px">Couldn't load data files (${err.message}).
     Serve this folder over HTTP — e.g. <code>npx serve</code> or <code>python3 -m http.server</code> —
     rather than opening index.html directly.</div>`);
});
