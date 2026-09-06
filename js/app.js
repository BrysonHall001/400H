/* app.js — 400H unit tracker */

const state = {
  plans: [],
  planHistory: [],
  unitHistory: [],
  building: null,
  watchlist: null,
  // shared filters (all tabs)
  f: { beds: new Set([1]), porch: false, avail: false, fmin: 9, fmax: 20, facing: new Set() },
  plansOn: new Set(),           // tracker-only plan refinement
  sort: { key: "unit", dir: 1 },
  uSearch: "",
  planChart: null,
  unitChart: null,
  dirty: false,
  bInited: false,
  bSelected: null,
};

const PALETTE = ["#2f6b4f", "#bfa05e", "#4e8a76", "#8a6d2f", "#1f3d33",
                 "#a4b06a", "#6fa28e", "#5b4a1e", "#3e5c53", "#d0b98a"];
const colorFor = (i) => PALETTE[i % PALETTE.length] || `hsl(${(i * 47) % 360} 35% 40%)`;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = (n) => n === null || n === undefined ? "—" : "$" + n.toLocaleString("en-US");

/* ---------------- data loading ---------------- */

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const CACHE_KEY = "400h-unit-history-cache";

function latestSnapshot() { return state.unitHistory[state.unitHistory.length - 1] || null; }
function latestByUnit() {
  const snap = latestSnapshot();
  const map = new Map();
  if (snap) for (const u of snap.units) map.set(u.unit, u);
  return map;
}
function rosterByUnit() { return new Map(state.building.units.map(u => [u.unit, u])); }
function planMeta(code) { return state.building.plans[code] || {}; }

async function boot() {
  const [plans, planHist, unitHist, building] = await Promise.all([
    loadJSON("data/plans.json"),
    loadJSON("data/plan-history.json"),
    loadJSON("data/unit-history.json"),
    loadJSON("data/building.json"),
  ]);
  state.plans = plans.plans;
  state.planHistory = planHist.history;
  state.unitHistory = unitHist.snapshots;
  state.building = building;
  state.watchlist = await loadJSON("data/watchlist.json").catch(() => null);

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    for (const snap of cached) {
      if (!state.unitHistory.some(s => s.date === snap.date)) {
        state.unitHistory.push(snap);
        state.dirty = true;
      }
    }
    state.unitHistory.sort((a, b) => a.date.localeCompare(b.date));
  } catch (_) { /* ignore */ }

  buildPlanChips();
  bindSharedFilters();
  renderAll();
  if (state.dirty) {
    showStatus("Restored an imported snapshot from this browser's cache — save it to data/unit-history.json to make it permanent.", false);
    $("#download-unit-history").hidden = false;
  }
}

/* ---------------- tabs ---------------- */

$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach(b => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", b === btn);
    });
    $$(".panel").forEach(p => p.hidden = true);
    $("#panel-" + btn.dataset.tab).hidden = false;
    if (btn.dataset.tab === "building") { initBuilding(); if (state.bInited) Building3D.resize(); }
  });
});

/* ---------------- shared filters (all tabs) ---------------- */

function bindSharedFilters() {
  $$(".f-beds .chip").forEach(chip => chip.addEventListener("click", () => {
    const n = Number(chip.dataset.beds);
    if (state.f.beds.has(n)) state.f.beds.delete(n); else state.f.beds.add(n);
    state.plansOn.clear();
    renderAll();
  }));
  $$(".f-facing .chip").forEach(chip => chip.addEventListener("click", () => {
    const d = chip.dataset.face;
    if (state.f.facing.has(d)) state.f.facing.delete(d); else state.f.facing.add(d);
    renderAll();
  }));
  $$(".f-porch").forEach(b => b.addEventListener("click", () => { state.f.porch = !state.f.porch; renderAll(); }));
  $$(".f-avail").forEach(b => b.addEventListener("click", () => { state.f.avail = !state.f.avail; renderAll(); }));
  $$(".f-fmin").forEach(i => i.addEventListener("change", () => { state.f.fmin = Number(i.value) || 9; renderAll(); }));
  $$(".f-fmax").forEach(i => i.addEventListener("change", () => { state.f.fmax = Number(i.value) || 20; renderAll(); }));
}

function syncSharedFilters() {
  $$(".f-beds .chip").forEach(c => c.classList.toggle("is-on", state.f.beds.has(Number(c.dataset.beds))));
  $$(".f-facing .chip").forEach(c => c.classList.toggle("is-on", state.f.facing.has(c.dataset.face)));
  $$(".f-porch").forEach(b => b.classList.toggle("is-on", state.f.porch));
  $$(".f-avail").forEach(b => b.classList.toggle("is-on", state.f.avail));
  $$(".f-fmin").forEach(i => { if (Number(i.value) !== state.f.fmin) i.value = state.f.fmin; });
  $$(".f-fmax").forEach(i => { if (Number(i.value) !== state.f.fmax) i.value = state.f.fmax; });
}

// unit-level match against shared filters
function matchesUnit(bu, { ignoreFloor = false, ignoreAvail = false } = {}) {
  if (state.f.beds.size && !state.f.beds.has(bu.beds)) return false;
  if (state.f.porch && !bu.porch) return false;
  if (state.f.facing.size && !(bu.facing || "").split("").some(d => state.f.facing.has(d))) return false;
  if (!ignoreFloor && (bu.floor < state.f.fmin || bu.floor > state.f.fmax)) return false;
  if (!ignoreAvail && state.f.avail && !latestByUnit().has(bu.unit)) return false;
  return true;
}

// plan-level match (floor/avail don't apply to plan-wide advertised prices)
function matchesPlan(code) {
  const m = planMeta(code);
  if (state.f.beds.size && !state.f.beds.has(m.beds)) return false;
  if (state.f.porch && !m.porch) return false;
  return true;
}

/* ---------------- tracker plan chips ---------------- */

function buildPlanChips() {
  const row = $("#plan-filter");
  row.innerHTML = "";
  state.plans.forEach(p => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.code;
    b.dataset.plan = p.code;
    b.addEventListener("click", () => {
      if (state.plansOn.has(p.code)) state.plansOn.delete(p.code);
      else state.plansOn.add(p.code);
      renderAll();
    });
    row.appendChild(b);
  });
}

function visiblePlans() {
  const eligible = state.plans.map(p => p.code).filter(matchesPlan);
  if (state.plansOn.size === 0) return eligible;
  return eligible.filter(c => state.plansOn.has(c));
}

function syncPlanChips() {
  const shown = new Set(visiblePlans());
  $$("#plan-filter .chip").forEach(c => {
    const eligible = matchesPlan(c.dataset.plan);
    c.style.display = eligible ? "" : "none";
    c.classList.toggle("is-on", shown.has(c.dataset.plan) && state.plansOn.size > 0);
    c.classList.toggle("is-partial", shown.has(c.dataset.plan) && state.plansOn.size === 0);
  });
}

/* ---------------- charts ---------------- */

function renderPlanChart() {
  const dates = [...new Set(state.planHistory.map(r => r.date))].sort();
  const shown = visiblePlans();
  const datasets = [];
  let colorIdx = 0;
  for (const code of shown) {
    const rows = new Map(state.planHistory.filter(r => r.plan === code).map(r => [r.date, r]));
    const mins = dates.map(d => rows.get(d)?.status === "priced" ? rows.get(d).total_min : null);
    const maxs = dates.map(d => rows.get(d)?.status === "priced" ? rows.get(d).total_max : null);
    if (mins.every(v => v === null)) { colorIdx++; continue; }
    const color = colorFor(colorIdx++);
    const hasBand = maxs.some((v, i) => v !== null && v !== mins[i]);
    if (hasBand) {
      datasets.push({ label: code + " max", planCode: code, data: maxs, borderColor: color + "55",
        borderDash: [4, 4], borderWidth: 1, pointRadius: 0, spanGaps: true, fill: false, legendHide: true });
      datasets.push({ label: code, planCode: code, data: mins, borderColor: color, backgroundColor: color + "1f",
        borderWidth: 2, pointRadius: 3, spanGaps: true, fill: "-1" });
    } else {
      datasets.push({ label: code, planCode: code, data: mins, borderColor: color,
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
      onClick: (e, els) => {
        if (!els.length) return;
        const code = datasets[els[0].datasetIndex].planCode;
        if (code) fillPlanPanel(code);
      },
      scales: { y: { ticks: { callback: v => "$" + v.toLocaleString() } } },
      plugins: {
        legend: { labels: { filter: item => !datasets[item.datasetIndex] || !datasets[item.datasetIndex].legendHide } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y?.toLocaleString()} — click for details` } },
      },
    },
  });
}

function unitSeries() {
  const series = new Map();
  for (const snap of state.unitHistory) {
    for (const u of snap.units) {
      if (!series.has(u.unit)) series.set(u.unit, { plan: u.plan, beds: u.beds, points: new Map() });
      series.get(u.unit).points.set(snap.date, u.total_price ?? u.price);
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
  const roster = rosterByUnit();
  const shownPlans = new Set(visiblePlans());
  const datasets = [];
  let i = 0;
  for (const [unit, s] of unitSeries()) {
    const bu = roster.get(unit);
    if (s.plan && !shownPlans.has(s.plan)) continue;
    if (bu && !matchesUnit(bu)) continue;
    datasets.push({
      label: `${unit} (${s.plan || "?"})`, unitNum: unit,
      data: dates.map(d => s.points.get(d) ?? null),
      borderColor: colorFor(i++), borderWidth: 2, pointRadius: 3, spanGaps: false, fill: false,
    });
  }
  if (state.unitChart) state.unitChart.destroy();
  state.unitChart = new Chart($("#unit-chart"), {
    type: "line",
    data: { labels: dates, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      onClick: (e, els) => {
        if (!els.length) return;
        const unit = datasets[els[0].datasetIndex].unitNum;
        const bu = rosterByUnit().get(unit);
        if (bu) { state.bSelected = unit; fillUnitPanel(bu); if (state.bInited) pushBuildingState(); }
      },
      scales: { y: { ticks: { callback: v => "$" + v.toLocaleString() } } },
      plugins: { tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y?.toLocaleString()} — click for details` } } },
    },
  });
}

/* ---------------- units table ---------------- */

$$("#units-table thead th").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (!key) return;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    renderUnitsTable();
  });
});
$("#u-search").addEventListener("input", e => { state.uSearch = e.target.value.trim().toUpperCase(); renderUnitsTable(); });

function rosterRows() {
  const live = latestByUnit();
  const runs = currentRuns();
  const snap = latestSnapshot();
  return state.building.units.map(u => {
    const l = live.get(u.unit);
    return {
      unit: u.unit, floor: u.floor, plan: u.plan, beds: u.beds, sqft: u.sqft,
      porch: u.porch, facing: u.facing || "—", confidence: u.confidence, _bu: u,
      price: l ? l.price : null,
      total_price: l ? l.total_price : null,
      available_on: l ? l.available_on : null,
      listed: !!l,
      dom: l && runs.get(u.unit) && snap ? dayDiff(runs.get(u.unit).since, snap.date) : null,
    };
  });
}

function renderUnitsTable() {
  const tbody = $("#units-table tbody");
  tbody.innerHTML = "";
  const snap = latestSnapshot();
  $("#units-asof").textContent = snap ? `· prices as of ${snap.date}` : "· no snapshot yet";
  let rows = rosterRows().filter(r => matchesUnit(r._bu));
  if (state.uSearch) rows = rows.filter(r => r.unit.includes(state.uSearch) || r.plan.toUpperCase().includes(state.uSearch));
  rows.sort((a, b) => {
    const k = state.sort.key;
    const av = a[k] ?? "", bv = b[k] ?? "";
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return cmp * state.sort.dir;
  });
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "row-click";
    tr.innerHTML = `
      <td>${r.unit}</td><td class="num">${r.floor}</td>
      <td>${r.plan}${r.confidence !== "confirmed" ? "<span class='muted'>*</span>" : ""}</td>
      <td class="num">${r.beds === 0 ? "St" : r.beds}</td>
      <td class="num">${r.sqft.toLocaleString()}</td>
      <td class="${r.porch ? "porch-yes" : ""}">${r.porch ? "Yes" : "—"}</td>
      <td>${r.facing}</td>
      <td class="num">${fmt(r.price)}</td><td class="num">${fmt(r.total_price)}</td>
      <td class="${r.listed ? "status-avail" : "status-not"}">${r.listed ? (r.available_on || "Listed") : "not listed"}</td>
      <td class="num">${r.dom ?? "—"}</td>`;
    tr.addEventListener("click", () => { state.bSelected = r.unit; fillUnitPanel(r._bu); if (state.bInited) pushBuildingState(); });
    tbody.appendChild(tr);
  }
}

/* ---------------- building (3D) ---------------- */

function pushBuildingState() {
  Building3D.applyState({
    filterFn: bu => matchesUnit(bu),
    availableSet: new Set(latestByUnit().keys()),
    selectedUnit: state.bSelected,
  });
}

function initBuilding() {
  if (state.bInited || !state.building) return;
  state.bInited = true;
  const snap = latestSnapshot();
  $("#bldg-asof").textContent = snap ? `· availability as of ${snap.date}` : "";
  Building3D.init($("#scene"), state.building, {
    onSelect: unit => { state.bSelected = unit.unit; fillUnitPanel(unit); pushBuildingState(); },
  });
  pushBuildingState();

  loadJSON("data/context.json").then(ctx => {
    Building3D.addContext(ctx);
    const chip = $("#b-context");
    chip.hidden = false;
    chip.classList.add("is-on");
    let on = true;
    chip.addEventListener("click", () => {
      on = !on;
      chip.classList.toggle("is-on", on);
      Building3D.setContextVisible(on);
    });
  }).catch(() => {});
}

/* ---------------- detail panel (global) ---------------- */

$("#unit-panel-close").addEventListener("click", () => {
  $("#unit-panel").hidden = true;
  state.bSelected = null;
  if (state.bInited) pushBuildingState();
});

function setPanelImages(plan) {
  const img = $("#up-img"), img2 = $("#up-img2");
  img.src = `assets/floorplans/${plan}.jpg`;
  img.hidden = false;
  img.onerror = () => { img.hidden = true; };
  img2.src = `assets/floorplans/${plan}-2d.jpg`;
  img2.hidden = false;
  img2.onerror = () => { img2.hidden = true; };
}

const FACE_NAMES = { N: "north", E: "east", S: "south", W: "west" };
function faceLabel(f) { return f && f !== "-" ? f.split("").map(d => FACE_NAMES[d]).join("/") + "-facing" : "interior"; }
function fillUnitPanel(u) {
  const live = latestByUnit().get(u.unit);
  const runs = currentRuns();
  const snap = latestSnapshot();
  $("#up-title").textContent = `Unit ${u.unit} · ${u.plan}`;
  $("#up-facts").textContent =
    `Floor ${u.floor} · ${u.beds === 0 ? "Studio" : u.beds + " bed"} / ${u.baths} bath · ${u.sqft.toLocaleString()} sq ft · ${u.porch ? "porch" : "no porch"}`;
  let status;
  if (live) {
    const r = runs.get(u.unit);
    const dom = r && snap ? dayDiff(r.since, snap.date) : 0;
    status = `<span class="status-avail">Available</span> ${live.available_on || ""} — ${fmt(live.total_price ?? live.price)}` +
      `${live.lease_term ? " · " + live.lease_term : ""}` +
      `${r ? ` · listed ${dom === 0 ? "today" : dom + "d"}` : ""}`;
  } else {
    status = `<span class="status-not">Not listed in the latest snapshot.</span>`;
  }
  $("#up-status").innerHTML = status;
  $("#up-confidence").textContent = u.confidence === "confirmed" ? ""
    : u.confidence === "inferred"
      ? "Plan inferred from unit geometry matched to official floorplans; auto-confirms if this unit is ever listed."
      : "Low-confidence assignment (one-off floor 9 unit) — treat plan as provisional.";
  setPanelImages(u.plan);
  $("#unit-panel").hidden = false;
}

function fillPlanPanel(code) {
  const m = planMeta(code);
  const units = state.building.units.filter(u => u.plan === code);
  const live = latestByUnit();
  const listed = units.filter(u => live.has(u.unit));
  const latestRow = [...state.planHistory].reverse().find(r => r.plan === code && r.status === "priced");
  $("#up-title").textContent = `Plan ${code}`;
  $("#up-facts").textContent =
    `${m.beds === 0 ? "Studio" : m.beds + " bed"} / ${m.baths} bath · ${m.sqft.toLocaleString()} sq ft · ` +
    `${m.porch ? "porch" : "no porch"} · ${units.length} unit${units.length !== 1 ? "s" : ""} in the building`;
  $("#up-status").innerHTML = latestRow
    ? `Advertised ${fmt(latestRow.total_min)}${latestRow.total_max !== latestRow.total_min ? " – " + fmt(latestRow.total_max) : ""}` +
      `${latestRow.units_left != null ? ` · ${latestRow.units_left} left` : ""}${latestRow.term_months ? ` · ${latestRow.term_months} mo` : ""}` +
      ` <span class="muted">(${latestRow.date})</span>` +
      (listed.length ? `<br>Listed now: ${listed.map(u => u.unit).join(", ")}` : "")
    : `<span class="status-not">No advertised price on record (Contact Us).</span>` +
      (listed.length ? `<br>Listed now: ${listed.map(u => u.unit).join(", ")}` : "");
  $("#up-confidence").textContent = "";
  setPanelImages(code);
  $("#unit-panel").hidden = false;
}

/* ---------------- listing timelines (DOM, deltas, events) ---------------- */

function dayDiff(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

function currentRuns() {
  const runs = new Map();
  for (const snap of state.unitHistory) {
    const seen = new Set();
    for (const u of snap.units) {
      seen.add(u.unit);
      const price = u.total_price ?? u.price;
      const r = runs.get(u.unit);
      if (!r || r.ended) runs.set(u.unit, { since: snap.date, firstPrice: price, lastPrice: price, ended: false });
      else { r.lastPrice = price; }
    }
    for (const [unit, r] of runs) if (!seen.has(unit)) r.ended = true;
  }
  for (const [unit, r] of runs) if (r.ended) runs.delete(unit);
  return runs;
}

function listingEvents() {
  const events = [];
  for (let i = 1; i < state.unitHistory.length; i++) {
    const prev = new Map(state.unitHistory[i - 1].units.map(u => [u.unit, u]));
    const cur = new Map(state.unitHistory[i].units.map(u => [u.unit, u]));
    const date = state.unitHistory[i].date;
    for (const [unit, u] of cur) if (!prev.has(unit))
      events.push({ date, kind: "listed", unit, plan: u.plan, price: u.total_price ?? u.price });
    for (const [unit, u] of prev) if (!cur.has(unit))
      events.push({ date, kind: "delisted", unit, plan: u.plan, price: u.total_price ?? u.price });
  }
  return events.reverse();
}

function renderWatchlist() {
  const el = $("#watchlist");
  if (!el) return;
  el.innerHTML = "";
  const w = state.watchlist;
  const snap = latestSnapshot();
  if (!w) { el.innerHTML = '<div class="empty">No data/watchlist.json found.</div>'; return; }
  if (!snap) { el.innerHTML = '<div class="empty">Watchlist activates with the first unit snapshot.</div>'; return; }
  const roster = rosterByUnit();
  const runs = currentRuns();
  const matches = [];
  for (const lu of snap.units) {
    const bu = roster.get(lu.unit);
    if (!bu) continue;
    if (w.beds && !w.beds.includes(bu.beds)) continue;
    if (w.porch && !bu.porch) continue;
    if (w.min_floor != null && bu.floor < w.min_floor) continue;
    if (w.max_floor != null && bu.floor > w.max_floor) continue;
    if (w.plans && !w.plans.includes(bu.plan)) continue;
    const price = lu.total_price ?? lu.price;
    if (w.max_total_price != null && price > w.max_total_price) continue;
    matches.push({ lu, bu, run: runs.get(lu.unit), price });
  }
  if (!matches.length) {
    el.innerHTML = '<div class="empty">Nothing in your lane is listed right now — which, this far out, is the expected state. The moment something matches, it appears here.</div>';
    return;
  }
  matches.sort((a, b) => b.bu.floor - a.bu.floor);
  for (const m of matches) {
    const dom = m.run ? dayDiff(m.run.since, snap.date) : 0;
    const delta = m.run && m.run.firstPrice != null && m.price != null ? m.price - m.run.firstPrice : null;
    const card = document.createElement("div");
    card.className = "watch-card row-click";
    card.innerHTML = `
      <div class="watch-main"><strong>Unit ${m.lu.unit}</strong> · ${m.bu.plan} · floor ${m.bu.floor} ·
        ${m.bu.sqft.toLocaleString()} sq ft · porch</div>
      <div class="watch-price">${fmt(m.price)}
        ${delta === null || delta === 0 ? "" : `<span class="${delta > 0 ? "delta-pos" : "delta-neg"}">(${delta > 0 ? "+" : "−"}$${Math.abs(delta).toLocaleString()} since listed)</span>`}
      </div>
      <div class="muted">available ${m.lu.available_on || "—"} · listed ${dom === 0 ? "today" : dom + " day" + (dom > 1 ? "s" : "")} ${m.run ? "(since " + m.run.since + ")" : ""}</div>`;
    card.addEventListener("click", () => { state.bSelected = m.bu.unit; fillUnitPanel(m.bu); if (state.bInited) pushBuildingState(); });
    el.appendChild(card);
  }
}

function renderEvents() {
  const tbody = $("#events-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const roster = rosterByUnit();
  const events = listingEvents().filter(e => {
    const bu = roster.get(e.unit);
    return !bu || matchesUnit(bu, { ignoreAvail: true });
  });
  $("#events-empty").hidden = events.length > 0;
  for (const e of events.slice(0, 40)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${e.date}</td>
      <td class="${e.kind === "listed" ? "status-avail" : "status-not"}">${e.kind}</td>
      <td>${e.unit}</td><td>${e.plan ?? "—"}</td><td class="num">${fmt(e.price)}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------------- spread analysis ---------------- */

function renderSpread() {
  const tbody = $("#spread-table tbody");
  tbody.innerHTML = "";
  const latest = latestSnapshot();
  $("#spread-empty").hidden = !!latest;
  if (!latest) return;
  const roster = rosterByUnit();
  const planRow = new Map();
  for (const r of state.planHistory) {
    if (r.date > latest.date || r.status !== "priced") continue;
    const cur = planRow.get(r.plan);
    if (!cur || r.date > cur.date) planRow.set(r.plan, r);
  }
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
    const bu = roster.get(u.unit);
    if (bu && !matchesUnit(bu)) continue;
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
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("is-over"); }));
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
    if (sightmapUrl) msg += ` SightMap feed URL: ${sightmapUrl}`;
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
  syncSharedFilters();
  syncPlanChips();
  renderWatchlist();
  renderPlanChart();
  renderUnitChart();
  renderEvents();
  renderSpread();
  renderUnitsTable();
  if (state.bInited) {
    const snap = latestSnapshot();
    $("#bldg-asof").textContent = snap ? `· availability as of ${snap.date}` : "";
    pushBuildingState();
  }
}

boot().catch(err => {
  document.body.insertAdjacentHTML("beforeend",
    `<div class="import-status is-error" style="margin:20px 28px">Couldn't load data files (${err.message}).
     Serve this folder over HTTP — e.g. <code>npx serve</code> or <code>python3 -m http.server</code> —
     rather than opening index.html directly.</div>`);
});
