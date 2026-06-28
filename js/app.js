/* ==========================================================================
   HRBP Workforce & Recruitment Command Centre — app.js
   All dashboard logic. Pure browser, no build step, no network at runtime.
   Reads window.DASHBOARD_DATA (baked) and re-renders on filter/selector change.
   ========================================================================== */
(function () {
"use strict";

// ---------- state ----------
var DATA = window.DASHBOARD_DATA;          // active dataset (swappable via upload)
window.__setDashboardData = function (d) {
  DATA = d;
  ST.hrbp = "all"; ST.filters = {};
  buildHrbpSelector();
  buildFilterBar();
  buildCompareSelectors();
  buildKpiDefs();
  renderSourceSummary();
  if (DATA.meta && DATA.meta.empty) { ST.activeView = "sec-exec"; }
  App.fullRender();
};

var ST = {
  hrbp: "all",          // 'all' or portfolio key
  scenario: "current",
  activeView: "sec-exec",
  view: "exec",         // exec | analyst
  filters: {},          // {dim: value}
  charts: {},           // chart instances by canvas id
};

var NA = "Not Available";

// ---------- tiny DOM helpers ----------
function $(s, r) { return (r || document).querySelector(s); }
function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function el(tag, attrs, html) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (html != null) e.innerHTML = html;
  return e;
}
function fmt(n) { return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-IN"); }
function pct(n) { return (n == null || isNaN(n)) ? "—" : (Math.round(n * 10) / 10) + "%"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

// ---------- RAG semantics (colour never the only signal) ----------
// Intervention red aligns to AM/NS Smart Red; neutral/info uses a legible blue.
var RAG = {
  green: "#2f8f43", amber: "#c79100", orange: "#d9710b",
  red: "#E52726", darkred: "#9b1414", grey: "#6f7176", blue: "#2b6cb0",
  ink: "#171717", brand: "#E52726",
};
// AM/NS brand chart palette — black/red dominant, secondary accents (never dominant).
var BRAND = {
  ink: "#171717", inkSoft: "#52525a", red: "#E52726", redSoft: "#f59b9a",
  yellow: "#FFA700", green: "#C0F353", blue: "#A8E0FF",
  series: ["#171717", "#E52726", "#FFA700", "#7BB23B", "#5BA9DA", "#9b1414", "#9a9aa0"],
};
function ragVacancy(p) { if (p == null) return "grey"; return p < 10 ? "green" : p <= 20 ? "amber" : "red"; }
function ragAttrition(p) { if (p == null) return "grey"; return p < 3 ? "green" : p <= 5 ? "amber" : "red"; }
function ragPms(p) { if (p == null) return "grey"; return p >= 95 ? "green" : p >= 85 ? "amber" : "red"; }
function ragAge(a) { if (a == null) return "grey"; return a <= 30 ? "green" : a <= 60 ? "amber" : a <= 90 ? "orange" : a <= 120 ? "red" : "darkred"; }
function ragRisk(b) { return b === "High" ? "red" : b === "Moderate" ? "amber" : "green"; }
function dot(rag) { return '<span class="rag-dot rag-' + rag + '"></span>'; }
function pill(rag, txt) { return '<span class="pill ' + rag + '">' + esc(txt) + '</span>'; }

// ---------- portfolio helpers ----------
function portfolios() { return DATA.portfolios; }
function pById(k) { for (var i = 0; i < DATA.portfolios.length; i++) if (DATA.portfolios[i].key === k) return DATA.portfolios[i]; return null; }
function activePortfolios() { return ST.hrbp === "all" ? DATA.portfolios : [pById(ST.hrbp)].filter(Boolean); }
function displayName() { return ST.hrbp === "all" ? "All HRBPs" : (pById(ST.hrbp) || {}).display; }

// Aggregate selected portfolios into one synthetic summary (applies scenario lens).
function aggregate() {
  var ps = activePortfolios();
  var a = {
    budget: 0, active: 0, vacancy: 0, joiningsYTD: 0, exitsYTD: 0,
    openPipeline: 0, offered: 0, joined: 0, future: 0, onHold: 0,
    b90: 0, wip: 0, pmsPendingW: 0, attrW: 0, activeForAttr: 0,
    toBeOffered: 0, ojtVacant: 0,
  };
  ps.forEach(function (p) {
    a.budget += p.budget || 0; a.active += p.active || 0;
    a.joiningsYTD += p.joiningsYTD || 0; a.exitsYTD += p.exitsYTD || 0;
    a.openPipeline += p.openPipeline || 0; a.offered += p.offered || 0;
    a.joined += p.joined || 0; a.future += p.future || 0; a.onHold += (p.onHold || 0);
    a.b90 += (p.aging && p.aging.b90) || 0; a.wip += (p.aging && p.aging.wip) || 0;
    a.toBeOffered += (p.recruitment.toBeOffered ? p.recruitment.toBeOffered.total : 0);
    a.attrW += (p.attrition || 0) * (p.active || 0); a.activeForAttr += (p.active || 0);
    a.pmsPendingW += (p.pmsPending || 0) * (p.active || 0);
  });
  a.vacancy = a.budget - a.active;
  a.attrition = a.activeForAttr ? Math.round(a.attrW / a.activeForAttr * 10) / 10 : null;
  a.pmsPending = a.activeForAttr ? Math.round(a.pmsPendingW / a.activeForAttr * 10) / 10 : null;
  a.vacancyPct = a.budget ? Math.round(a.vacancy / a.budget * 1000) / 10 : null;

  // live tracker counts for the selection (drive the scenario lens & open-roles insight)
  var trk = (DATA.recruitmentRecords || []).filter(function (r) {
    return r.portfolio && (ST.hrbp === "all" || r.portfolio === ST.hrbp);
  });
  a.trkOpen = trk.filter(function (r) { return ["Joined", "Confirmation", "Internal Movement"].indexOf(r.status) < 0; }).length;
  a.trkOffered = trk.filter(function (r) { return r.status === "Offered"; }).length;
  a.trkConfirm = trk.filter(function (r) { return r.status === "Confirmation"; }).length;
  a.trkHold = trk.filter(function (r) { return r.status === "Hold"; }).length;
  // ageing metrics count WIP + To Be Offered only
  var trkAge = ageingScope(trk);
  a.trkB90 = trkAge.filter(function (r) { return r.ageingBucket === "91-120" || r.ageingBucket === "121+"; }).length;
  a.trkTatBreach = trkAge.filter(function (r) { return r.tatBreach; }).length;

  // ----- Scenario Lens (simulated) — driven by the live tracker -----
  var s = ST.scenario, simNote = null;
  var activeSim = a.active, vacSim = a.vacancy, pipeSim = a.openPipeline || a.trkOpen;
  if (s === "offered") { activeSim += a.trkOffered; pipeSim -= a.trkOffered; simNote = "If offered roles join (+" + a.trkOffered + ")"; }
  else if (s === "ojt") { activeSim += a.trkConfirm; pipeSim -= a.trkConfirm; simNote = "If OJT/GET confirmations complete (+" + a.trkConfirm + ")"; }
  else if (s === "hold") { pipeSim += a.trkHold; simNote = "If hold roles released into pipeline (+" + a.trkHold + ")"; }
  else if (s === "age90") { pipeSim -= a.trkB90; activeSim += a.trkB90; simNote = "If 90+ day roles closed (+" + a.trkB90 + ")"; }
  a.activeSim = activeSim;
  a.vacSim = a.budget - activeSim;
  a.vacPctSim = a.budget ? Math.round((a.budget - activeSim) / a.budget * 1000) / 10 : null;
  a.pipeSim = Math.max(0, pipeSim);
  a.simNote = simNote;
  return a;
}
function ojtVacantCount(p) {
  return (DATA.budgetRecords || []).filter(function (r) {
    return r.portfolio === p.key && r.employeeType === "OJT" && r.occupancy === "Vacant";
  }).length;
}

// ---------- filtered budget records (for headcount section + filters) ----------
function filteredBudget() {
  var recs = DATA.budgetRecords || [];
  return recs.filter(function (r) {
    if (ST.hrbp !== "all" && r.portfolio !== ST.hrbp) return false;
    if (ST.filters.function && r.function !== ST.filters.function) return false;
    if (ST.filters.location && r.plant !== ST.filters.location) return false;
    if (ST.filters.grade && gradeBand(r.grade) !== ST.filters.grade) return false;
    if (ST.filters.occupancy && r.occupancy !== ST.filters.occupancy) return false;
    return true;
  });
}
function gradeBand(g) {
  if (!g || g === NA) return NA;
  var m = String(g).match(/([A-Za-z]+)[ -]?(\d+)/);
  if (m) return m[1].toUpperCase().slice(0, 1) + "-band";
  return g;
}

// ---------- filtered recruitment-tracker records (recruitment / ageing / analyst) ----------
function trackerInScope() {
  var f = ST.filters;
  return (DATA.recruitmentRecords || []).filter(function (r) {
    if (ST.hrbp !== "all" && r.portfolio !== ST.hrbp) return false;
    if (f.function && r.function !== f.function) return false;
    if (f.location && r.location !== f.location) return false;
    if (f.grade && gradeBand(r.grade) !== f.grade) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.sourcing && r.sourcing !== f.sourcing) return false;
    if (f.criticality && r.criticality !== f.criticality) return false;
    if (f.recType && r.positionType !== f.recType) return false;
    if (f.year && r.budgetedYear !== f.year) return false;
    return true;
  });
}

// Ageing (and its derivatives — buckets, 90+, TAT breach) only applies to roles
// actively in the hiring window: WIP and To Be Offered. Every other status
// (Yet to Start, Offered, Hold, Joined, Confirmation, Internal Movement) is
// excluded from ageing calculations.
var AGEING_STATUSES = ["WIP", "To Be Offered"];
function ageingScope(recs) {
  return recs.filter(function (r) { return AGEING_STATUSES.indexOf(r.status) >= 0; });
}

/* =========================================================================
   CHART FACTORY — destroy/recreate cleanly on every render (perf §AG)
   ========================================================================= */
Chart.defaults.font.family = "'Segoe UI',system-ui,sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = "#5a6577";
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.boxHeight = 12;
Chart.defaults.maintainAspectRatio = false;

function chart(id, cfg) {
  var cv = document.getElementById(id);
  if (!cv) return;
  if (ST.charts[id]) { ST.charts[id].destroy(); }
  ST.charts[id] = new Chart(cv.getContext("2d"), cfg);
  return ST.charts[id];
}
function refLine(value, label, color) {
  return {
    type: "line", borderColor: color || "#cc3340", borderWidth: 1.5, borderDash: [5, 4],
    label: { display: true, content: label, position: "end", backgroundColor: color || "#cc3340",
      color: "#fff", font: { size: 9 }, padding: 3 },
    yMin: value, yMax: value, xMin: -0.5, xMax: 100,
  };
}
function tip(extra) {
  return { callbacks: extra || {} };
}

/* =========================================================================
   APP
   ========================================================================= */
var App = {};

App.init = function () {
  document.title = DATA.meta.title;
  $("#dashTitle").textContent = DATA.meta.title;
  $("#dashSub").textContent = DATA.meta.subtitle;
  $("#updatedChip").textContent = "Updated " + DATA.meta.generatedAt;
  buildHrbpSelector();
  buildNav();
  buildQuickViews();
  buildFilterBar();
  buildKpiDefs();
  buildCompareSelectors();
  wireControls();
  renderSourceSummary();
  decorateInfo();
  applyView();
  App.fullRender();
  setupScrollSpy();
};

/* ---------- self-explanatory "i" affordances on every visual ---------- */
var CHART_INFO = {
  chBudgetActive: "Budget vs Active headcount per portfolio. Budget = Total Position 2026 (approved plan); Active = employees on roll. The gap between the two bars is the vacancy.",
  chVacancy: "Vacancy % = (Budget − Active) ÷ Budget, per portfolio, sorted highest first. RAG: green <10%, amber 10–20%, red >20%.",
  chJoinExit: "Joinings YTD vs Exits YTD per portfolio. When exits exceed joinings the portfolio is shrinking (negative net movement).",
  chAttrition: "Attrition % per portfolio = exits ÷ active over the period. The dashed line is the company (active-weighted) average. RAG: green <3%, amber 3–5%, red >5%.",
  chRisk: "Portfolio Risk Index (0–100): weighted blend of Vacancy 25, Ageing 25, Attrition 20, Hiring load 15, PMS pending 10, Engagement 5 — each scaled to the highest portfolio. A workload/risk indicator, not an assessment of HRBP performance.",
  chFnGap: "Occupied vs Vacant positions by function (budget records), sorted by the vacancy gap. Vacant = a budgeted position with no current employee.",
  chOccVac: "Share of budgeted positions in the current selection that are Occupied vs Vacant.",
  chEmpType: "Count of budgeted positions by employee type (Regular / Trainee / OJT / Contractual).",
  chGrade: "Count of budgeted positions by grade band (grouped on the grade-code prefix).",
  chFunnel: "Live recruitment pipeline by Current Status (Recruitment Tracker): Yet to Start → WIP → To-Be-Offered → Offered → Joined, for the current selection. % is share of all tracked roles.",
  chSourcing: "Mix of sourcing channels across the pipeline (RPO, OJT/GET Confirmation, Consultant, ER, Internal, …) — the top channels by volume.",
  chStageByHrbp: "Recruitment status composition (Yet to Start / WIP / To-Be-Offered / Offered / Joined / Confirmation / Hold) stacked per portfolio.",
  chPosType: "The functions with the most open roles in the pipeline (top 8), from the live tracker — where hiring demand is concentrated.",
  chAgeBuckets: "WIP + To-Be-Offered roles per portfolio split into mutually-exclusive ageing buckets — each role is counted in exactly one. Ageing is calculated ONLY for status WIP or To Be Offered; all other statuses are excluded. Bucket = derived from the tracker's numeric \"Ageing\" (days): 0–30 (≤30), 31–60, 61–90, 91–120, 121+ (>120). The text \"Ageing Bucket\" label is only a fallback when days are blank.",
  chAgeHist: "Distribution of numeric \"Ageing\" (days) for WIP + To-Be-Offered roles in the current selection, in the same mutually-exclusive buckets (0–30 / 31–60 / 61–90 / 91–120 / 121+ — no role counted twice). Other statuses are excluded. TAT breach = a role whose Ageing exceeds its per-row Agreed TAT (days).",
  chMovement: "Joinings vs Exits (June and YTD) with a net-movement line. Net = Joinings − Exits.",
  chWaterfall: "Workforce movement YTD: Opening active + Joinings − Exits = Closing active.",
  chPms: "Goal-setting completion % per portfolio against the 95% target line. PMS pending % = 100 − goal-setting %.",
  chEngagement: "Employee listening score by department against the company benchmark (6.19). Bars below benchmark are red.",
  chTrainDays: "Training days delivered per portfolio, parsed from the Training & Development section (e.g. \"251.62 days\").",
  chInitMonth: "Number of HR-initiative events scheduled per month (Jan–Dec) for the selection.",
  chInitCat: "HR initiatives by category (Engagement, Capability, Compliance, PMS, Communication, Culture), classified from each event's text.",
};
function infoIcon(text, flip) {
  var s = el("span", { class: "info-i" + (flip ? " flip" : ""), tabindex: "0", role: "img" });
  s.setAttribute("data-tip", text);
  s.setAttribute("aria-label", "Explanation: " + text);
  s.textContent = "i";
  return s;
}
function decorateInfo() {
  Object.keys(CHART_INFO).forEach(function (id) {
    var cv = document.getElementById(id);
    if (!cv) return;
    var card = cv.closest(".chart-card");
    var h = card && card.querySelector("h3");
    if (!h || h.querySelector(".info-i")) return;
    h.appendChild(infoIcon(CHART_INFO[id]));
  });
  $all("[data-info]").forEach(function (node) {
    if (node.querySelector(".info-i")) return;
    node.appendChild(infoIcon(node.getAttribute("data-info"), node.classList.contains("info-right")));
  });
}

// Infinite scroll: render EVERY section (all visible on one continuous page).
function renderActive() {
  VIEW_IDS.forEach(function (id) {
    var fn = VIEW_RENDER[id];
    if (fn) { try { fn(); } catch (e) { console.error(e); } }
  });
  applyView();
}

App.fullRender = function () {
  $("#updatedChip").textContent = DATA.meta.empty ? "No data" : "Updated " + DATA.meta.generatedAt;
  buildHrbpSelector();
  toggleEmpty();
  renderFilterChips();
  if (!(DATA.meta.empty || !DATA.portfolios.length)) renderActive();
};

/* ---------- selectors / tabbed nav ---------- */
function buildHrbpSelector() {
  var sel = $("#hrbpSel");
  var cur = sel.value || "all";
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "all" }, "All HRBPs"));
  portfolios().forEach(function (p) {
    sel.appendChild(el("option", { value: p.key }, p.display));
  });
  sel.value = portfolios().some(function (p) { return p.key === cur; }) ? cur : "all";
  if (sel.value !== ST.hrbp) ST.hrbp = sel.value;
}

// Each view = one tab panel. Render map keeps charts lazy (built when shown).
var VIEW_RENDER = {
  "sec-exec": function () { renderHealthBand(); renderKpis(); renderStory(); },
  "sec-compare": renderComparison,
  "sec-headcount": renderHeadcount,
  "sec-funnel": renderFunnel,
  "sec-ageing": renderAgeing,
  "sec-critical": renderCritical,
  "sec-attrition": renderAttrition,
  "sec-pms": renderPms,
  "sec-engagement": renderEngagement,
  "sec-training": renderTraining,
  "sec-initiatives": renderInitiatives,
  "sec-dq": renderDataQuality,
  "sec-actions": renderActions,
  "sec-compare2": renderCompare,
  "sec-defs": function () {},
};
var VIEW_IDS = Object.keys(VIEW_RENDER);
var VIEW_GROUPS = [
  ["Overview", [["sec-exec", "Executive Summary"], ["sec-compare", "HRBP Comparison"]]],
  ["Workforce", [["sec-headcount", "Headcount & Budget"], ["sec-attrition", "Attrition & Movement"]]],
  ["Recruitment", [["sec-funnel", "Recruitment Funnel"], ["sec-ageing", "Ageing & TAT"], ["sec-critical", "Critical Cases"]]],
  ["People", [["sec-pms", "PMS Readiness"], ["sec-engagement", "Speak-Up & Engagement"], ["sec-training", "Training"], ["sec-initiatives", "HR Initiatives"]]],
  ["Governance", [["sec-dq", "Data Quality"], ["sec-actions", "Monthly Actions"]]],
  ["Tools", [["sec-compare2", "Compare Portfolios"], ["sec-defs", "KPI Definitions"]]],
];
function buildNav() {
  var nav = $("#scrollspy");
  nav.innerHTML = "";
  VIEW_GROUPS.forEach(function (g) {
    nav.appendChild(el("div", { class: "nav-group" }, g[0]));
    g[1].forEach(function (s) {
      var a = el("a", { href: "#" + s[0] }, s[1]);
      a.dataset.target = s[0];
      a.onclick = function (e) { e.preventDefault(); showView(s[0]); };
      nav.appendChild(a);
    });
  });
}
// Nav / quick-views / search jump to a section (continuous scroll).
function showView(id) {
  var n = document.getElementById(id);
  if (!n) return;
  n.scrollIntoView({ behavior: "smooth", block: "start" });
  document.body.classList.remove("nav-open");
}
// Scroll-spy: highlight the nav item for the section currently in view.
function setupScrollSpy() {
  var links = $all("#scrollspy a");
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        links.forEach(function (l) { l.classList.toggle("active", l.dataset.target === en.target.id); });
      }
    });
  }, { rootMargin: "-130px 0px -65% 0px" });
  VIEW_IDS.forEach(function (id) { var n = document.getElementById(id); if (n) obs.observe(n); });
}
function toggleEmpty() {
  var empty = !!(DATA.meta.empty || !DATA.portfolios.length);
  $("#emptyHero").classList.toggle("hidden", !empty);
  var sp = document.querySelector(".scrollspy"); if (sp) sp.classList.toggle("hidden", empty);
  $("#quickViews").classList.toggle("hidden", empty);
  $("#sec-filters").classList.toggle("hidden", empty);
  VIEW_IDS.forEach(function (v) { var n = document.getElementById(v); if (n) n.classList.toggle("view-hidden", empty); });
  var chip = $("#loadChip");
  if (empty) { chip.className = "status-chip empty"; chip.textContent = "No data loaded"; }
}
var QUICKVIEWS = [
  ["Overall Health", "sec-exec"], ["Vacancy Pressure", "sec-headcount"],
  ["Ageing Risk", "sec-ageing"], ["Critical Roles", "sec-critical"],
  ["Attrition Watch", "sec-attrition"], ["PMS Readiness", "sec-pms"],
  ["Speak-Up Actions", "sec-engagement"], ["Training Coverage", "sec-training"],
  ["Data Quality", "sec-dq"], ["Monthly Actions", "sec-actions"],
];
function buildQuickViews() {
  var c = $("#quickViews");
  c.innerHTML = "";
  QUICKVIEWS.forEach(function (q) {
    var b = el("button", {}, q[0]);
    b.onclick = function () { showView(q[1]); };
    c.appendChild(b);
  });
}

/* ---------- C. filter bar ---------- */
// src: 'tracker' | 'budget'.  field: column on that record set (or 'grade' band).
var FILTER_DEFS = [
  { key: "function", label: "Function", src: "tracker", field: "function" },
  { key: "location", label: "Location", src: "tracker", field: "location" },
  { key: "status", label: "Status", src: "tracker", field: "status" },
  { key: "sourcing", label: "Sourcing", src: "tracker", field: "sourcing" },
  { key: "criticality", label: "Criticality", src: "tracker", field: "criticality" },
  { key: "recType", label: "Recruitment type", src: "tracker", field: "positionType" },
  { key: "year", label: "Budgeted year", src: "tracker", field: "budgetedYear" },
  { key: "grade", label: "Grade band", src: "tracker", field: "grade", band: true },
  { key: "occupancy", label: "Occupancy", src: "budget", field: "occupancy" },
];
function buildFilterBar() {
  var bar = $("#filterBar");
  bar.innerHTML = "";
  FILTER_DEFS.forEach(function (f) {
    var wrap = el("div", { class: "f" });
    wrap.appendChild(el("label", {}, f.label));
    var sel = el("select", { id: "flt-" + f.key });
    sel.onchange = function () {
      if (sel.value) ST.filters[f.key] = sel.value; else delete ST.filters[f.key];
      App.fullRender(); refreshFilterOptions();
    };
    wrap.appendChild(sel);
    bar.appendChild(wrap);
  });
  refreshFilterOptions();
}
function refreshFilterOptions() {
  var trk = (DATA.recruitmentRecords || []).filter(function (r) { return ST.hrbp === "all" || r.portfolio === ST.hrbp; });
  var bud = (DATA.budgetRecords || []).filter(function (r) { return ST.hrbp === "all" || r.portfolio === ST.hrbp; });
  FILTER_DEFS.forEach(function (f) {
    var sel = $("#flt-" + f.key);
    if (!sel) return;
    var recs = f.src === "budget" ? bud : trk;
    var vals = f.band ? uniq(recs.map(function (r) { return gradeBand(r[f.field]); }))
                      : uniq(recs.map(function (r) { return r[f.field]; }));
    vals = vals.filter(function (v) { return v && v !== NA; }).sort();
    var cur = ST.filters[f.key] || "";
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "" }, "All"));
    vals.forEach(function (v) {
      var o = el("option", { value: v }, v);
      if (v === cur) o.setAttribute("selected", "true");
      sel.appendChild(o);
    });
    sel.value = cur;
  });
}
function uniq(a) { var s = {}; a.forEach(function (x) { s[x] = 1; }); return Object.keys(s); }
function renderFilterChips() {
  var c = $("#filterChips");
  c.innerHTML = "";
  var keys = Object.keys(ST.filters);
  if (ST.hrbp !== "all") {
    addChip(c, "HRBP: " + displayName(), function () { setHrbp("all"); });
  }
  keys.forEach(function (k) {
    addChip(c, fLabel(k) + ": " + ST.filters[k], function () { delete ST.filters[k]; App.fullRender(); refreshFilterOptions(); });
  });
  if (keys.length || ST.hrbp !== "all") {
    var clr = el("button", { class: "btn ghost btn-sm" }, "Clear all");
    clr.onclick = resetAll;
    c.appendChild(clr);
    c.appendChild(el("span", { class: "muted", style: "font-size:11px" },
      trackerInScope().length + " recruitment · " + filteredBudget().length + " budget records match"));
  }
}
function fLabel(k) { for (var i = 0; i < FILTER_DEFS.length; i++) if (FILTER_DEFS[i].key === k) return FILTER_DEFS[i].label; return k; }
function addChip(c, txt, onx) {
  var chip = el("span", { class: "chip" }, esc(txt) + " ");
  var b = el("button", { "aria-label": "Remove filter" }, "×");
  b.onclick = onx; chip.appendChild(b); c.appendChild(chip);
}
function setHrbp(k) {
  ST.hrbp = k; $("#hrbpSel").value = k;
  refreshFilterOptions(); App.fullRender();
}
function resetAll() {
  ST.hrbp = "all"; ST.filters = {}; ST.scenario = "current";
  $("#hrbpSel").value = "all"; $("#scenarioSel").value = "current";
  buildFilterBar(); App.fullRender();
}

/* ---------- D. KPI strip ---------- */
function renderKpis() {
  var a = aggregate();
  var k = [
    { l: "2026 Position Budget", v: fmt(a.budget), sub: "Budgeted positions", rag: "blue", ins: "Total approved headcount plan", def: "Sum of Total Position 2026 (Budget)." },
    { l: "Active Headcount", v: fmt(a.active), sub: pct(a.budget ? a.active / a.budget * 100 : null) + " of budget", rag: "blue", ins: "People currently on roll", def: "Active Employees from the review." },
    { l: "Vacancy Count", v: fmt(a.vacancy), sub: "Budget − Active", rag: ragVacancy(a.vacancyPct), ins: a.vacancy > 0 ? "Open against plan" : "Fully staffed", def: "Vacancy = Budget − Active." },
    { l: "Vacancy %", v: pct(a.vacancyPct), sub: "RAG G<10 · A 10-20 · R>20", rag: ragVacancy(a.vacancyPct), ins: a.vacancyPct > 20 ? "Intervention needed" : a.vacancyPct > 10 ? "Watch" : "Healthy", def: "Vacancy / Budget." },
    { l: "Joinings YTD", v: fmt(a.joiningsYTD), sub: "Exits YTD: " + fmt(a.exitsYTD), rag: a.joiningsYTD >= a.exitsYTD ? "green" : "amber", ins: "Net " + (a.joiningsYTD - a.exitsYTD >= 0 ? "+" : "") + (a.joiningsYTD - a.exitsYTD) + " YTD", def: "Joining's YTD." },
    { l: "Exits YTD", v: fmt(a.exitsYTD), sub: "Net movement " + (a.joiningsYTD - a.exitsYTD), rag: a.exitsYTD > a.joiningsYTD ? "red" : "green", ins: a.exitsYTD > a.joiningsYTD ? "Losing faster than building" : "Building capacity", def: "Exits YTD." },
    { l: "Attrition %", v: pct(a.attrition), sub: "Company avg " + pct(weightedCompanyAttr()), rag: ragAttrition(a.attrition), ins: a.attrition > 5 ? "Above threshold" : "Within range", def: "Active-weighted attrition; G<3 A 3-5 R>5." },
    { l: "Open Hiring Pipeline", v: fmt(a.openPipeline), sub: "WIP+ToBeOffered+Offered", rag: "blue", ins: a.joined + " joined YTD · " + a.offered + " offered", def: "WIP + To-Be-Offered + Offered." },
  ];
  var strip = $("#kpiStrip");
  strip.innerHTML = "";
  k.forEach(function (c) {
    var card = el("div", { class: "kpi rag-" + c.rag, tabindex: "0", role: "button" });
    card.innerHTML =
      '<div class="k-top"><span class="k-label">' + esc(c.l) + '</span>' +
      '<span>' + dot(c.rag) + ' <span class="info" title="' + esc(c.def) + '">i</span></span></div>' +
      '<div class="k-val">' + c.v + '</div><div class="k-sub">' + esc(c.sub) + '</div>' +
      '<div class="k-insight">' + esc(c.ins) + '</div>';
    card.onclick = function () { openKpiDrawer(c.l); };
    strip.appendChild(card);
  });
  // scenario banner
  if (a.simNote) {
    var b = el("div", { class: "dq-banner", style: "margin-top:14px;background:#e8e3fb;border-color:#c9bdf0;color:#42339a" },
      "🔬 <span><b>Simulated projection (" + esc(a.simNote) + "):</b> Active → " + fmt(a.activeSim) +
      " · Vacancy → " + fmt(a.vacSim) + " (" + pct(a.vacPctSim) + ") · Open pipeline → " + fmt(a.pipeSim) + "</span>");
    strip.appendChild(b);
  }
}
function weightedCompanyAttr() {
  var w = 0, a = 0;
  DATA.portfolios.forEach(function (p) { w += (p.attrition || 0) * (p.active || 0); a += (p.active || 0); });
  return a ? Math.round(w / a * 10) / 10 : null;
}

/* ---------- portfolio health band (scannable overview) ---------- */
function renderHealthBand() {
  var band = $("#portfolioHealth");
  if (!band) return;
  var sc = $("#execScope"); if (sc) sc.textContent = displayName();
  band.innerHTML = "";
  DATA.portfolios.forEach(function (p) {
    var rag = ragRisk(p.riskBand);
    var b90 = (p.tracker && p.tracker.ageing90plus) || 0;
    var tip = p.display + " — Risk " + (p.riskBand || "—") + " (index " + (p.riskIndex || 0) + "/100). " +
      "Vacancy " + pct(p.vacancyPct) + " · Attrition " + pct(p.attrition) + " · " +
      b90 + " open roles 90+ days. Click to focus this portfolio.";
    var tile = el("div", { class: "health-tile" + (ST.hrbp === p.key ? " active" : ""), tabindex: "0", role: "button", title: tip });
    tile.innerHTML =
      '<div class="ht-top"><span class="ht-name">' + esc(p.display) + '</span>' + dot(rag) + '</div>' +
      '<div class="ht-band ' + rag + '">' + esc(p.riskBand || "—") + ' risk</div>' +
      '<div class="ht-metrics"><span>Vac ' + pct(p.vacancyPct) + '</span><span>Attr ' + pct(p.attrition) + '</span>' +
      '<span>90+ ' + fmt(b90) + '</span></div>';
    tile.onclick = function () { setHrbp(ST.hrbp === p.key ? "all" : p.key); };
    band.appendChild(tile);
  });
}

/* ---------- E. portfolio story ---------- */
function renderStory() {
  var ps = activePortfolios();
  var a = aggregate();
  var nar = $("#storyNarrative");
  var name = displayName();
  var lead;
  if (ST.hrbp === "all") {
    lead = "<b>" + esc(name) + "</b> covers " + fmt(a.budget) + " budgeted positions across " +
      DATA.portfolios.length + " portfolios, with " + fmt(a.active) + " active (" +
      pct(a.budget ? a.active / a.budget * 100 : null) + " filled). Vacancy stands at <b>" + fmt(a.vacancy) +
      "</b> (" + pct(a.vacancyPct) + "). YTD the group added " + a.joiningsYTD + " and lost " + a.exitsYTD +
      " (net " + (a.joiningsYTD - a.exitsYTD) + "). The live tracker shows <b>" + a.trkOpen +
      "</b> open roles — " + a.trkB90 + " ageing 90+ days and " + a.trkTatBreach + " past their agreed TAT.";
  } else {
    var p = ps[0], t = p.tracker || {};
    var lowEng = p.engagementLowestScore;
    lead = "<b>" + esc(p.display) + "</b> manages " + fmt(p.budget) + " budgeted positions, " +
      fmt(p.active) + " active — vacancy <b>" + fmt(p.vacancy) + "</b> (" + pct(p.vacancyPct) + ", " +
      ragWord(ragVacancy(p.vacancyPct)) + "). Live pipeline: " + (t.open || 0) + " open roles, " +
      (t.ageing90plus || 0) + " ageing 90+ days, " + (t.tatBreach || 0) + " past agreed TAT" +
      (t.highCrit ? ", " + t.highCrit + " high-criticality" : "") + ". Attrition <b>" +
      pct(p.attrition) + "</b> (" + ragWord(ragAttrition(p.attrition)) + "). PMS goal-setting at " +
      pct((p.pms || {}).goalSetting) + ". " +
      (lowEng != null ? "Engagement watch: " + esc(p.engagementLowest) + " at " + lowEng + " vs company " + DATA.meta.benchmark + ". " : "") +
      (p.training ? "Training delivered " + (p.training.trainingDays != null ? p.training.trainingDays + " days. " : "(days N/A). ") : "");
  }
  nar.innerHTML = '<p class="lead">' + lead + "</p>";
  if (ST.hrbp !== "all" && ps[0].attritionInsight && ps[0].attritionInsight !== NA) {
    nar.innerHTML += '<p class="note"><b>Attrition insight:</b> ' + esc(ps[0].attritionInsight) + "</p>";
  }

  // key risks
  var risks = $("#storyRisks"); risks.innerHTML = "";
  computeRisks(ps).forEach(function (r) {
    risks.appendChild(el("li", {}, dot(r.rag) + " <span>" + esc(r.txt) + "</span>"));
  });
  // recommended actions (from derived action list)
  var acts = $("#storyActions"); acts.innerHTML = "";
  var rel = DATA.actions.filter(function (x) { return ST.hrbp === "all" || x.hrbp === displayName(); }).slice(0, 5);
  if (!rel.length) acts.innerHTML = '<li class="muted">No priority actions for this selection.</li>';
  rel.forEach(function (x) {
    acts.appendChild(el("li", {}, pill(x.priority === "P1" ? "red" : "amber", x.priority) +
      " <span><b>" + esc(x.theme) + "</b> — " + esc(x.recommendation) + "</span>"));
  });
}
function ragWord(r) { return { green: "healthy", amber: "watch", orange: "elevated", red: "intervention", darkred: "critical", grey: "n/a" }[r]; }
function computeRisks(ps) {
  var out = [];
  ps.forEach(function (p) {
    var t = p.tracker || {};
    if (p.vacancyPct != null && p.vacancyPct > 20) out.push({ rag: "red", txt: p.display + ": vacancy " + pct(p.vacancyPct) });
    if ((t.ageing90plus || 0) >= 10) out.push({ rag: "red", txt: p.display + ": " + t.ageing90plus + " open roles 90+ days" });
    if (t.tatBreach) out.push({ rag: "orange", txt: p.display + ": " + t.tatBreach + " roles past agreed TAT" });
    if (p.attrition != null && p.attrition > 5) out.push({ rag: "red", txt: p.display + ": attrition " + pct(p.attrition) });
    if (t.highCrit) out.push({ rag: "orange", txt: p.display + ": " + t.highCrit + " high-criticality roles open" });
    if ((p.pms || {}).goalSetting != null && p.pms.goalSetting < 85) out.push({ rag: "amber", txt: p.display + ": PMS goal-setting " + pct(p.pms.goalSetting) });
  });
  if (!out.length) out.push({ rag: "green", txt: "No threshold breaches in current selection." });
  return out.slice(0, 8);
}

/* ---------- F. comparison charts ---------- */
function renderComparison() {
  var ps = DATA.portfolios;
  var labels = ps.map(function (p) { return p.display; });
  chart("chBudgetActive", {
    type: "bar",
    data: { labels: labels, datasets: [
      { label: "Budget", data: ps.map(function (p) { return p.budget; }), backgroundColor: "#d2d2d6" },
      { label: "Active", data: ps.map(function (p) { return p.active; }), backgroundColor: BRAND.ink }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  // vacancy sorted desc, RAG coloured
  var vs = ps.slice().sort(function (a, b) { return (b.vacancyPct || 0) - (a.vacancyPct || 0); });
  chart("chVacancy", {
    type: "bar",
    data: { labels: vs.map(function (p) { return p.display; }), datasets: [{
      label: "Vacancy %", data: vs.map(function (p) { return p.vacancyPct; }),
      backgroundColor: vs.map(function (p) { return RAG[ragVacancy(p.vacancyPct)]; }) }] },
    options: baseOpts({ x: { beginAtZero: true } }, "y", function (ctx) {
      return ctx.raw + "% vacancy · " + ragWord(ragVacancy(ctx.raw)); }),
  });
  chart("chJoinExit", {
    type: "bar",
    data: { labels: labels, datasets: [
      { label: "Joinings YTD", data: ps.map(function (p) { return p.joiningsYTD; }), backgroundColor: RAG.green },
      { label: "Exits YTD", data: ps.map(function (p) { return p.exitsYTD; }), backgroundColor: RAG.red }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  var avg = weightedCompanyAttr();
  chart("chAttrition", {
    type: "bar",
    data: { labels: labels, datasets: [{ label: "Attrition %", data: ps.map(function (p) { return p.attrition; }),
      backgroundColor: ps.map(function (p) { return RAG[ragAttrition(p.attrition)]; }) }] },
    options: baseOpts({ y: { beginAtZero: true } }, null, null, { annotation: annoLine(avg, "Company avg " + avg + "%") }),
  });
  var rs = ps.slice().sort(function (a, b) { return b.riskIndex - a.riskIndex; });
  chart("chRisk", {
    type: "bar",
    data: { labels: rs.map(function (p) { return p.display + " (" + p.riskBand + ")"; }), datasets: [{
      label: "Risk index", data: rs.map(function (p) { return p.riskIndex; }),
      backgroundColor: rs.map(function (p) { return RAG[ragRisk(p.riskBand)]; }) }] },
    options: baseOpts({ x: { beginAtZero: true, max: 100 } }, "y", function (ctx) {
      return "Risk " + ctx.raw + " · " + rs[ctx.dataIndex].riskBand + " attention"; }),
  });
}
function annoLine(v, label) {
  return { annotations: { line: {
    type: "line", yMin: v, yMax: v, borderColor: "#cc3340", borderWidth: 1.5, borderDash: [5, 4],
    label: { display: true, content: label, position: "end", backgroundColor: "#cc3340", color: "#fff", font: { size: 9 } } } } };
}
// Minimal annotation emulation without the plugin: draw via a tiny inline plugin.
var hLinePlugin = {
  id: "hline",
  afterDraw: function (c) {
    var a = c.options.plugins && c.options.plugins.annotation;
    if (!a || !a.annotations || !a.annotations.line) return;
    var ln = a.annotations.line, y = c.scales.y; if (!y) return;
    var py = y.getPixelForValue(ln.yMin);
    var ctx = c.ctx; ctx.save();
    ctx.strokeStyle = ln.borderColor; ctx.lineWidth = ln.borderWidth; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(c.chartArea.left, py); ctx.lineTo(c.chartArea.right, py); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = ln.borderColor; ctx.font = "9px Segoe UI";
    ctx.textAlign = "right"; ctx.fillText(ln.label.content, c.chartArea.right - 4, py - 4);
    ctx.restore();
  }
};
Chart.register(hLinePlugin);

function baseOpts(scales, indexAxis, tipLabel, plugins) {
  var o = {
    indexAxis: indexAxis || "x",
    scales: scales || {},
    plugins: Object.assign({
      legend: { display: true, position: "bottom" },
      tooltip: { callbacks: tipLabel ? { label: function (ctx) { return tipLabel(ctx); } } : {} },
    }, plugins || {}),
  };
  return o;
}

/* ---------- G. headcount & budget ---------- */
function renderHeadcount() {
  var recs = filteredBudget();
  // insight cards
  var byFn = groupSum(recs, "function");
  var gapArr = Object.keys(byFn).map(function (fn) {
    var g = byFn[fn]; return { fn: fn, vac: g.vacant, tot: g.total, vacPct: g.total ? g.vacant / g.total * 100 : 0 };
  }).sort(function (a, b) { return b.vac - a.vac; });
  var byLoc = groupSum(recs, "plant");
  var locArr = Object.keys(byLoc).map(function (l) { return { l: l, vacPct: byLoc[l].total ? byLoc[l].vacant / byLoc[l].total * 100 : 0, vac: byLoc[l].vacant }; })
    .filter(function (x) { return byLoc[x.l].total >= 3; }).sort(function (a, b) { return b.vacPct - a.vacPct; });
  var bestFn = gapArr.slice().sort(function (a, b) { return a.vacPct - b.vacPct; })[0];
  var ic = $("#hcInsights"); ic.innerHTML = "";
  insightCard(ic, "Largest gap", gapArr[0] ? gapArr[0].fn : "—", gapArr[0] ? gapArr[0].vac + " vacant (" + Math.round(gapArr[0].vacPct) + "%)" : "", "red", "The function with the most vacant budgeted positions in the current selection.");
  insightCard(ic, "Best-staffed function", bestFn ? bestFn.fn : "—", bestFn ? Math.round(bestFn.vacPct) + "% vacant" : "", "green", "The function with the lowest vacancy % (vacant ÷ total positions).");
  insightCard(ic, "Highest location risk", locArr[0] ? locArr[0].l : "—", locArr[0] ? Math.round(locArr[0].vacPct) + "% vacant" : "", "orange", "Location with the highest vacancy % (min 3 positions to qualify).");
  insightCard(ic, "Records in view", fmt(recs.length), recs.filter(function (r) { return r.occupancy === "Vacant"; }).length + " vacant", "blue", "Number of budget position records matching the current HRBP and filters.");

  // budget vs actual by function (top 12 by gap)
  var top = gapArr.slice(0, 12);
  chart("chFnGap", {
    type: "bar",
    data: { labels: top.map(function (x) { return x.fn; }), datasets: [
      { label: "Occupied", data: top.map(function (x) { return byFn[x.fn].occupied; }), backgroundColor: RAG.blue, stack: "s" },
      { label: "Vacant", data: top.map(function (x) { return byFn[x.fn].vacant; }), backgroundColor: RAG.red, stack: "s" }] },
    options: baseOpts({ x: { stacked: true, beginAtZero: true }, y: { stacked: true } }, "y"),
  });
  // occupied vs vacant donut
  var occ = recs.filter(function (r) { return r.occupancy === "Occupied"; }).length;
  var vac = recs.length - occ;
  chart("chOccVac", {
    type: "doughnut",
    data: { labels: ["Occupied", "Vacant"], datasets: [{ data: [occ, vac], backgroundColor: [BRAND.ink, RAG.red] }] },
    options: { plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: function (c) {
      return c.label + ": " + fmt(c.raw) + " (" + Math.round(c.raw / (occ + vac) * 100) + "%)"; } } } } },
  });
  // employee type
  var byType = countBy(recs, "employeeType");
  chart("chEmpType", {
    type: "bar",
    data: { labels: Object.keys(byType), datasets: [{ label: "Positions", data: Object.values(byType),
      backgroundColor: BRAND.series }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  // grade pyramid
  var byGrade = countBy(recs.map(function (r) { return { g: gradeBand(r.grade) }; }).filter(function (r) { return r.g !== NA; }), "g");
  var gk = Object.keys(byGrade).sort();
  chart("chGrade", {
    type: "bar",
    data: { labels: gk, datasets: [{ label: "Positions", data: gk.map(function (k) { return byGrade[k]; }), backgroundColor: BRAND.ink }] },
    options: baseOpts({ x: { beginAtZero: true } }, "y"),
  });
  renderHcHeat(recs);
  renderHcTable(gapArr, byFn);
}
function insightCard(parent, label, val, sub, rag, info) {
  var card = el("div", { class: "card" },
    '<div class="k-label" style="font-size:10px;color:#5a6577;display:inline-flex">' + esc(label) + '</div>' +
    '<div style="font-size:17px;font-weight:800;margin:4px 0">' + dot(rag) + " " + esc(val) + '</div>' +
    '<div class="muted" style="font-size:11px">' + esc(sub) + '</div>');
  if (info) card.querySelector(".k-label").appendChild(infoIcon(info));
  parent.appendChild(card);
}
function groupSum(recs, key) {
  var g = {};
  recs.forEach(function (r) {
    var k = r[key] || NA; if (k === NA) return;
    if (!g[k]) g[k] = { total: 0, occupied: 0, vacant: 0 };
    g[k].total++; if (r.occupancy === "Vacant") g[k].vacant++; else g[k].occupied++;
  });
  return g;
}
function countBy(recs, key) { var g = {}; recs.forEach(function (r) { var k = r[key] || NA; g[k] = (g[k] || 0) + 1; }); return g; }

function renderHcHeat(recs) {
  // Pick the busiest functions and locations BY RECORD COUNT so the cross-tab is
  // dense (the real "Function Plant" field is high-cardinality; arbitrary slices
  // rarely intersect). Restrict to cells that actually co-occur.
  var fnG = groupSum(recs, "function"), locG = groupSum(recs, "plant");
  var fns = Object.keys(fnG).filter(function (k) { return k !== NA; })
    .sort(function (a, b) { return fnG[b].total - fnG[a].total; }).slice(0, 12);
  var locs = Object.keys(locG).filter(function (k) { return k !== NA; })
    .sort(function (a, b) { return locG[b].total - locG[a].total; }).slice(0, 10);
  var cont = $("#hcHeat");
  if (!fns.length || !locs.length) { cont.innerHTML = emptyState("No function/location data for this selection."); return; }
  var t = "<table class='heat'><thead><tr><th class='row-h'>Function ↓ / Location →</th>";
  locs.forEach(function (l) { t += "<th>" + esc(l) + "</th>"; });
  t += "</tr></thead><tbody>";
  fns.forEach(function (fn) {
    t += "<tr><th class='row-h'>" + esc(fn) + "</th>";
    locs.forEach(function (loc) {
      var cell = recs.filter(function (r) { return r.function === fn && r.plant === loc; });
      var tot = cell.length, vac = cell.filter(function (r) { return r.occupancy === "Vacant"; }).length;
      var p = tot ? vac / tot * 100 : null;
      var bg = p == null ? "#f6f8fc" : heatColor(p);
      t += "<td><div class='cell' style='background:" + bg + "' data-fn='" + esc(fn) + "' data-loc='" + esc(loc) +
        "' title='" + esc(fn) + " × " + esc(loc) + ": " + vac + "/" + tot + " vacant'>" +
        (tot ? Math.round(p) + "%" : "·") + "</div></td>";
    });
    t += "</tr>";
  });
  t += "</tbody></table>";
  cont.innerHTML = t;
  $all(".cell", cont).forEach(function (c) {
    if (!c.dataset.fn) return;
    c.onclick = function () { ST.filters.function = c.dataset.fn; ST.filters.location = c.dataset.loc; refreshFilterOptions(); App.fullRender(); document.getElementById("sec-headcount").scrollIntoView({ behavior: "smooth" }); };
  });
}
function heatColor(p) {
  // 0% green -> 100% dark red
  var stops = [[0, [228, 245, 236]], [10, [232, 244, 216]], [20, [251, 243, 218]], [40, [251, 233, 214]], [60, [251, 227, 229]], [100, [245, 216, 219]]];
  for (var i = 1; i < stops.length; i++) if (p <= stops[i][0]) { return "rgb(" + stops[i][1].join(",") + ")"; }
  return "rgb(245,216,219)";
}
function renderHcTable(gapArr, byFn) {
  var rows = gapArr.map(function (x) {
    var g = byFn[x.fn];
    return [x.fn, g.total, g.occupied, g.vacant, Math.round(x.vacPct) + "%"];
  });
  makeTable("#hcTable", ["Function", "Budget", "Active", "Vacant", "Vacancy %"], rows, { id: "hc" });
}

/* ---------- H. recruitment funnel (from the live tracker, per HRBP) ---------- */
var STATUS_COLORS = {
  "Yet to Start": "#c2c2c6", "WIP": "#8a8a90", "To Be Offered": BRAND.yellow,
  "Offered": RAG.red, "Joined": BRAND.ink, "Confirmation": RAG.green, "Hold": RAG.darkred,
  "Internal Movement": "#7a86a0", "Unknown": "#dcdcdc",
};
function statusCount(recs, s) { return recs.filter(function (r) { return r.status === s; }).length; }
function renderFunnel() {
  var recs = trackerInScope();
  var open = recs.filter(function (r) { return ["Joined", "Confirmation", "Internal Movement"].indexOf(r.status) < 0; }).length;
  var joined = statusCount(recs, "Joined"), hold = statusCount(recs, "Hold");
  // TAT breach is an ageing metric — count WIP + To Be Offered only
  var tatBreach = ageingScope(recs).filter(function (r) { return r.tatBreach; }).length;
  var highCrit = recs.filter(function (r) { return r.criticality === "High"; }).length;

  var fm = $("#funnelMetrics"); fm.innerHTML = "";
  insightCard(fm, "Open roles", fmt(open), fmt(recs.length) + " in tracker", "blue",
    "Roles in the live Recruitment Tracker not yet Joined / Confirmed / Internally-moved, for the current selection.");
  insightCard(fm, "Joined", fmt(joined), statusCount(recs, "Offered") + " at Offered", "green",
    "Roles with Current Status = Joined.");
  insightCard(fm, "On hold", fmt(hold), statusCount(recs, "Yet to Start") + " yet to start", "grey",
    "Roles with status Hold (awaiting business), and those not yet started.");
  insightCard(fm, "TAT breach / High-crit", fmt(tatBreach) + " / " + fmt(highCrit), "vs agreed TAT", tatBreach || highCrit ? "red" : "green",
    "WIP / To-Be-Offered roles aged beyond their per-row Agreed TAT, and the count of High-criticality roles still open.");

  // pipeline funnel by status
  var fl = ["Yet to Start", "WIP", "To Be Offered", "Offered", "Joined"];
  var fv = fl.map(function (s) { return statusCount(recs, s); });
  chart("chFunnel", {
    type: "bar",
    data: { labels: fl, datasets: [{ label: "Roles", data: fv, backgroundColor: fl.map(function (s) { return STATUS_COLORS[s]; }) }] },
    options: baseOpts({ x: { beginAtZero: true } }, "y", function (ctx) {
      var tot = recs.length || 1; return ctx.raw + " roles · " + Math.round(ctx.raw / tot * 100) + "% of pipeline"; }),
  });
  // sourcing channel mix (top)
  var src = topN(countByField(recs, "sourcing"), 7);
  chart("chSourcing", {
    type: "doughnut",
    data: { labels: src.map(function (x) { return x[0]; }), datasets: [{ data: src.map(function (x) { return x[1]; }),
      backgroundColor: BRAND.series.concat(["#c9c9cd", "#e0e0e3"]) }] },
    options: { plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 10 } } } } },
  });
  // status by portfolio (stacked)
  var sp = DATA.portfolios, statuses = ["Yet to Start", "WIP", "To Be Offered", "Offered", "Joined", "Confirmation", "Hold"];
  chart("chStageByHrbp", {
    type: "bar",
    data: { labels: sp.map(function (p) { return p.display; }), datasets: statuses.map(function (s) {
      return { label: s, backgroundColor: STATUS_COLORS[s],
        data: sp.map(function (p) { return (DATA.recruitmentRecords || []).filter(function (r) { return r.portfolio === p.key && r.status === s; }).length; }) };
    }) },
    options: baseOpts({ x: { stacked: true }, y: { stacked: true, beginAtZero: true } }),
  });
  // open roles by function (top 8)
  var fn = topN(countByField(recs, "function"), 8);
  chart("chPosType", {
    type: "bar",
    data: { labels: fn.map(function (x) { return x[0]; }), datasets: [{ label: "Roles", data: fn.map(function (x) { return x[1]; }), backgroundColor: BRAND.ink }] },
    options: baseOpts({ x: { beginAtZero: true } }, "y", function (ctx) { return ctx.raw + " open roles"; }),
  });
}
function countByField(recs, key) { var g = {}; recs.forEach(function (r) { var v = r[key]; if (v && v !== NA) g[v] = (g[v] || 0) + 1; }); return g; }
function topN(obj, n) { return Object.keys(obj).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n); }

/* ---------- I. ageing & TAT (from the live tracker) ---------- */
// Mutually-exclusive buckets — labels share no endpoints; each role is counted once.
var BUCKET_ORDER = ["0-30", "31-60", "61-90", "91-120", "121+"];
var BUCKET_COLORS = { "0-30": RAG.green, "31-60": RAG.amber, "61-90": RAG.orange, "91-120": RAG.red, "121+": RAG.darkred };
function renderAgeing() {
  var sp = DATA.portfolios;
  // Ageing only applies to roles actively in the hiring window — WIP and To Be
  // Offered. Every other status is excluded. The bucket itself is derived at
  // build-time from the numeric "Ageing" (days) column when present, falling back
  // to the tracker's "Ageing Bucket" label only when days are missing.
  var all = ageingScope(DATA.recruitmentRecords || []);
  // ageing-bucket distribution per portfolio (WIP + To Be Offered)
  chart("chAgeBuckets", {
    type: "bar",
    data: { labels: sp.map(function (p) { return p.display; }), datasets: BUCKET_ORDER.map(function (bk) {
      return { label: bk, backgroundColor: BUCKET_COLORS[bk],
        data: sp.map(function (p) { return all.filter(function (r) { return r.portfolio === p.key && r.ageingBucket === bk; }).length; }) };
    }) },
    options: baseOpts({ x: { stacked: true }, y: { stacked: true, beginAtZero: true } }),
  });
  // numeric ageing distribution (WIP + To Be Offered in the current selection)
  var recs = ageingScope(trackerInScope());
  var ages = recs.map(function (r) { return r.ageing; }).filter(function (a) { return a != null; });
  var bins = [0, 30, 60, 90, 120, 1e9], counts = BUCKET_ORDER.map(function () { return 0; });
  ages.forEach(function (a) { for (var i = 0; i < BUCKET_ORDER.length; i++) if (a <= bins[i + 1]) { counts[i]++; break; } });
  chart("chAgeHist", {
    type: "bar",
    data: { labels: BUCKET_ORDER, datasets: [{ label: "Roles (n=" + ages.length + ")", data: counts,
      backgroundColor: BUCKET_ORDER.map(function (b) { return BUCKET_COLORS[b]; }) }] },
    options: baseOpts({ y: { beginAtZero: true } }, null, function (ctx) {
      return ctx.raw + " roles · " + (ages.length ? Math.round(ctx.raw / ages.length * 100) : 0) + "% (numeric ageing)"; }),
  });
  // top ageing roles table (real, masked role ids)
  var top = recs.filter(function (r) { return r.ageing != null; })
    .sort(function (a, b) { return b.ageing - a.ageing; }).slice(0, 100)
    .map(function (r) {
      return [r.roleId, r.position, r.function, r.location, r.grade, r.ageing, r.ageingBucket,
        r.tatBreach ? "Breach" : "—", r.criticality, r.status];
    });
  makeTable("#ageTable", ["Role", "Title", "Function", "Location", "Grade", "Ageing (d)", "Bucket", "TAT", "Criticality", "Status"],
    top, { id: "age", rowClick: function (row) { openRoleModal(row[0]); } });
}

/* ---------- J. critical cases ---------- */
function renderCritical() {
  var ps = activePortfolios();
  var grid = $("#critGrid"); grid.innerHTML = "";
  var any = false;
  ps.forEach(function (p) {
    (p.criticalCases || []).forEach(function (role, i) {
      any = true;
      var sev = i === 0 ? "high" : i === 1 ? "medium" : "";
      var c = el("div", { class: "crit " + sev });
      c.innerHTML = "<h4>" + esc(role) + "</h4>" +
        '<div class="meta"><b>Portfolio:</b> ' + esc(p.display) + "</div>" +
        '<div class="meta"><b>Rank:</b> Top ' + (i + 1) + " critical case</div>" +
        '<div class="meta"><b>Ageing / Status / Owner:</b> ' + NA + " (text-only in source)</div>" +
        '<div class="actions"></div>';
      var acts = $(".actions", c);
      acts.appendChild(btn("Add to Action List", function () { toast("Added “" + role + "” to action list"); }));
      acts.appendChild(btn("Copy summary", function () { copy("Critical case (" + p.display + "): " + role + " — escalate this month."); }));
      grid.appendChild(c);
    });
  });
  if (!any) grid.innerHTML = emptyState("No critical cases flagged for this selection.");
}

/* ---------- K. attrition ---------- */
function renderAttrition() {
  var ps = activePortfolios();
  var a = aggregate();
  // movement: June vs YTD joinings/exits with net line
  var labels = ps.length === 1 ? ["June", "YTD"] : ps.map(function (p) { return p.display; });
  if (ps.length === 1) {
    var p = ps[0];
    chart("chMovement", {
      type: "bar",
      data: { labels: ["June", "YTD"], datasets: [
        { label: "Joinings", data: [p.joiningsJune, p.joiningsYTD], backgroundColor: RAG.green },
        { label: "Exits", data: [p.exitsJune, p.exitsYTD], backgroundColor: RAG.red },
        { type: "line", label: "Net", data: [(p.joiningsJune || 0) - (p.exitsJune || 0), (p.joiningsYTD || 0) - (p.exitsYTD || 0)], borderColor: RAG.blue, backgroundColor: RAG.blue, tension: .2 }] },
      options: baseOpts({ y: { beginAtZero: true } }),
    });
  } else {
    chart("chMovement", {
      type: "bar",
      data: { labels: labels, datasets: [
        { label: "Joinings YTD", data: ps.map(function (p) { return p.joiningsYTD; }), backgroundColor: RAG.green },
        { label: "Exits YTD", data: ps.map(function (p) { return p.exitsYTD; }), backgroundColor: RAG.red },
        { type: "line", label: "Net", data: ps.map(function (p) { return p.netMovementYTD; }), borderColor: RAG.blue, backgroundColor: RAG.blue }] },
      options: baseOpts({ y: { beginAtZero: true } }),
    });
  }
  // waterfall (Active start -> +join -> -exit -> closing)
  var startActive = a.active - a.joiningsYTD + a.exitsYTD;
  var wf = [
    { l: "Opening active", v: startActive, base: 0, c: RAG.grey },
    { l: "+ Joinings YTD", v: a.joiningsYTD, base: startActive, c: RAG.green },
    { l: "− Exits YTD", v: a.exitsYTD, base: a.active, c: RAG.red },
    { l: "Closing active", v: a.active, base: 0, c: RAG.blue },
  ];
  chart("chWaterfall", {
    type: "bar",
    data: { labels: wf.map(function (x) { return x.l; }), datasets: [{
      data: wf.map(function (x) { return [x.base, x.base + x.v]; }),
      backgroundColor: wf.map(function (x) { return x.c; }) }] },
    options: baseOpts({ y: { beginAtZero: true } }, null, function (ctx) {
      return wf[ctx.dataIndex].l + ": " + fmt(wf[ctx.dataIndex].v); }, { legend: { display: false } }),
  });
  // insight text
  var box = $("#attritionInsight");
  var ins = ps.map(function (p) { return "<b>" + esc(p.display) + ":</b> " + esc(p.attritionInsight || NA); }).join("<br/>");
  box.innerHTML = ins + '<div class="note">Exit-reason / by-function / regrettable-exit breakdowns are not present in the source — the qualitative insight text is shown instead.</div>';
}

/* ---------- L. PMS ---------- */
function renderPms() {
  var ps = DATA.portfolios;
  chart("chPms", {
    type: "bar",
    data: { labels: ps.map(function (p) { return p.display; }), datasets: [{ label: "Goal-setting %",
      data: ps.map(function (p) { return (p.pms || {}).goalSetting; }),
      backgroundColor: ps.map(function (p) { return RAG[ragPms((p.pms || {}).goalSetting)]; }) }] },
    options: baseOpts({ y: { beginAtZero: true, max: 100 } }, null, null, { annotation: annoLine(95, "Target 95%") }),
  });
  var rows = ps.map(function (p) {
    var g = (p.pms || {}).goalSetting;
    return [p.display, pct(g), pct(p.pmsPending), (p.pms || {}).midYear || NA, (p.pms || {}).endYear || NA,
      ragWord(ragPms(g))];
  });
  makeTable("#pmsMatrix", ["Portfolio", "Goal setting", "Pending", "Mid-year", "End-year", "Status"], rows, { id: "pms" });
}

/* ---------- M. engagement / speakup ---------- */
function renderEngagement() {
  var eng = (DATA.engagement || []).filter(function (e) { return e.score != null; });
  if (ST.hrbp !== "all") {
    var rl = pById(ST.hrbp).reviewLabel;
    var f = eng.filter(function (e) { return e.hrbp && e.hrbp.toLowerCase() === rl.toLowerCase(); });
    if (f.length) eng = f;
  }
  eng = eng.slice().sort(function (a, b) { return a.score - b.score; });
  var bench = DATA.meta.benchmark;
  chart("chEngagement", {
    type: "bar",
    data: { labels: eng.map(function (e) { return e.department; }), datasets: [{ label: "Listening score",
      data: eng.map(function (e) { return e.score; }),
      backgroundColor: eng.map(function (e) { return e.score < bench ? RAG.red : e.score < bench + 1 ? RAG.amber : RAG.green; }) }] },
    options: baseOpts({ x: { beginAtZero: true, max: 10 } }, "y", function (ctx) {
      return ctx.raw + " · " + (ctx.raw < bench ? "below" : "above") + " company " + bench; }, { annotationV: bench }),
  });
  // speakup timeline (use first portfolio's status / aggregate completed)
  var ms = DATA.speakUpMilestones || [];
  var tl = $("#speakupTimeline"); tl.innerHTML = "";
  ms.forEach(function (m) {
    var statuses = Object.values(m.status || {});
    var doneCount = statuses.filter(function (s) { return /complete/i.test(s); }).length;
    var done = doneCount === statuses.length && statuses.length > 0;
    var step = el("div", { class: "tl-step " + (done ? "done" : "pending") });
    step.innerHTML = esc(m.milestone) + '<span class="st">' + (done ? "Completed" : doneCount + "/" + statuses.length + " done") + "</span>";
    step.style.cursor = "pointer";
    step.onclick = function () { openSpeakupDrawer(m); };
    tl.appendChild(step);
  });
  // dept × milestone grid (compact)
  var grid = $("#speakupGrid");
  if (!ms.length) { grid.innerHTML = ""; return; }
  var hrbps = Object.keys(ms[0].status || {});
  var t = "<table class='heat'><thead><tr><th class='row-h'>Milestone</th>";
  hrbps.forEach(function (h) { t += "<th>" + esc(h) + "</th>"; });
  t += "</tr></thead><tbody>";
  ms.forEach(function (m) {
    t += "<tr><th class='row-h'>" + esc(m.milestone) + "</th>";
    hrbps.forEach(function (h) {
      var s = m.status[h] || "Pending";
      var done = /complete/i.test(s);
      t += "<td><div class='cell' style='background:" + (done ? "#e4f5ec" : "#fbf3da") + "'>" + (done ? "✓" : "•") + "</div></td>";
    });
    t += "</tr>";
  });
  grid.innerHTML = t + "</tbody></table>";
}

/* ---------- N. training ---------- */
function renderTraining() {
  var ps = DATA.portfolios;
  chart("chTrainDays", {
    type: "bar",
    data: { labels: ps.map(function (p) { return p.display; }), datasets: [{ label: "Training days",
      data: ps.map(function (p) { return p.training ? p.training.trainingDays : null; }), backgroundColor: RAG.blue }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  var up = $("#trainUpcoming"); up.innerHTML = "";
  var rows = activePortfolios().map(function (p) {
    var t = p.training || {};
    return [p.display, t.totalHeadcount != null ? fmt(t.totalHeadcount) : NA,
      t.trainingDays != null ? t.trainingDays + " days" : NA, t.upcoming || NA];
  });
  makeTable("#trainUpcoming", ["Portfolio", "Headcount", "Training days", "Upcoming"], rows, { id: "train" });
}

/* ---------- O. initiatives ---------- */
function renderInitiatives() {
  var inits = DATA.initiatives || [];
  if (ST.hrbp !== "all") {
    var rl = pById(ST.hrbp).reviewLabel;
    inits = inits.filter(function (x) { return x.hrbp === rl; });
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  var byMonth = MONTHS.map(function (m) { return inits.filter(function (x) { return x.month === m; }).length; });
  chart("chInitMonth", {
    type: "bar",
    data: { labels: MONTHS, datasets: [{ label: "Events", data: byMonth, backgroundColor: BRAND.ink }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  var byCat = countByField(inits, "category");
  chart("chInitCat", {
    type: "doughnut",
    data: { labels: Object.keys(byCat), datasets: [{ data: Object.values(byCat),
      backgroundColor: BRAND.series }] },
    options: { plugins: { legend: { position: "bottom" } } },
  });
  // coverage heatmap portfolio × month (always full set)
  var cont = $("#initHeat");
  var all = DATA.initiatives || [];
  var t = "<table class='heat'><thead><tr><th class='row-h'>Portfolio</th>";
  MONTHS.forEach(function (m) { t += "<th>" + esc(m) + "</th>"; });
  t += "</tr></thead><tbody>";
  DATA.portfolios.forEach(function (p) {
    t += "<tr><th class='row-h'>" + esc(p.display) + "</th>";
    MONTHS.forEach(function (m) {
      var n = all.filter(function (x) { return x.hrbp === p.reviewLabel && x.month === m; }).length;
      var bg = n === 0 ? "#f6f8fc" : n < 3 ? "#e1ecf8" : n < 6 ? "#bcd6f2" : "#7fb0e6";
      t += "<td><div class='cell' style='background:" + bg + "' data-hrbp='" + esc(p.reviewLabel) + "' data-month='" + esc(m) + "'>" + (n || "·") + "</div></td>";
    });
    t += "</tr>";
  });
  cont.innerHTML = t + "</tbody></table>";
  $all(".cell", cont).forEach(function (c) {
    if (!c.dataset.hrbp) return;
    c.onclick = function () {
      var list = all.filter(function (x) { return x.hrbp === c.dataset.hrbp && x.month === c.dataset.month; });
      openListDrawer(c.dataset.hrbp + " — " + c.dataset.month + " events",
        list.map(function (x) { return "[" + x.category + "] " + x.event; }));
    };
  });
}

/* ---------- P. data quality ---------- */
function renderDataQuality() {
  var dq = DATA.dataQuality;
  var m = $("#dqMetrics"); m.innerHTML = "";
  insightCard(m, "Completeness", dq.completeness + "%", "tracker numeric/criticality", dq.completeness > 70 ? "green" : dq.completeness > 40 ? "amber" : "red", "Share of usable tracker fields present (penalised for missing ageing and criticality).");
  insightCard(m, "Tracker rows", fmt(dq.trackerRows), "record-level (degraded)", "grey", "Recruitment Tracker data rows. Categorical fields here are degraded by anonymisation.");
  insightCard(m, "Budget rows", fmt(dq.budgetRows), "record-level (usable)", "blue", "Budget workbook position-level records (usable for headcount/vacancy).");
  insightCard(m, "Action-required issues", fmt(dq.actionRequired), "high severity", dq.actionRequired ? "red" : "green", "Count of high-severity data-quality issues that warrant attention before acting.");
  var rows = (dq.issues || []).map(function (i) {
    return [i.type, fmt(i.count), pill(i.severity === "high" ? "red" : i.severity === "medium" ? "amber" : "grey", i.severity), i.detail];
  });
  makeTable("#dqTable", ["Issue type", "Count", "Severity", "Detail"], rows, { id: "dq", raw: [3] });
}

/* ---------- Q. actions ---------- */
function renderActions() {
  var theme = $("#actTheme").value, owner = $("#actOwner").value, prio = $("#actPriority").value, red = $("#actRedOnly").checked;
  // populate filter selects once
  fillSelectOnce($("#actTheme"), uniq(DATA.actions.map(function (a) { return a.theme; })));
  fillSelectOnce($("#actOwner"), uniq(DATA.actions.map(function (a) { return a.owner; })));
  var acts = DATA.actions.filter(function (a) {
    if (ST.hrbp !== "all" && a.hrbp !== displayName()) return false;
    if (theme && a.theme !== theme) return false;
    if (owner && a.owner !== owner) return false;
    if (prio && a.priority !== prio) return false;
    if (red && a.priority !== "P1") return false;
    return true;
  });
  window.__filteredActions = acts;
  var rows = acts.map(function (a) {
    return [pill(a.priority === "P1" ? "red" : a.priority === "P2" ? "amber" : "grey", a.priority),
      a.hrbp, a.theme, a.issue, a.evidence, a.recommendation, a.owner,
      statusSelect(a), ""];
  });
  if (!rows.length) { $("#actionsTable").innerHTML = emptyState("No actions for this filter.", resetActionFilters); return; }
  makeTable("#actionsTable", ["Priority", "HRBP", "Theme", "Issue", "Evidence", "Recommended action", "Owner", "Status", ""], rows,
    { id: "act", raw: [0, 7] });
}
function statusSelect(a) {
  var opts = ["Not Started", "In Progress", "Awaiting Business", "Awaiting TA", "Closed"];
  return "<select data-act='" + a.id + "' class='actStatus' style='font-size:11px;padding:2px 4px'>" +
    opts.map(function (o) { return "<option" + (o === a.status ? " selected" : "") + ">" + o + "</option>"; }).join("") + "</select>";
}
function resetActionFilters() { $("#actTheme").value = ""; $("#actOwner").value = ""; $("#actPriority").value = ""; $("#actRedOnly").checked = false; renderActions(); }
function fillSelectOnce(sel, vals) {
  if (sel.dataset.filled) return;
  vals.sort().forEach(function (v) { sel.appendChild(el("option", { value: v }, v)); });
  sel.dataset.filled = "1";
}

/* ---------- X. compare two ---------- */
function buildCompareSelectors() {
  [$("#cmpA"), $("#cmpB")].forEach(function (sel, idx) {
    sel.innerHTML = "";
    DATA.portfolios.forEach(function (p) { sel.appendChild(el("option", { value: p.key }, p.display)); });
    sel.selectedIndex = idx === 0 ? 0 : Math.min(1, DATA.portfolios.length - 1);
    sel.onchange = renderCompare;
  });
}
function renderCompare() {
  var A = pById($("#cmpA").value), B = pById($("#cmpB").value);
  if (!A || !B) return;
  var rows = [
    ["Metric", A.display, B.display],
    ["Budget", A.budget, B.budget], ["Active", A.active, B.active],
    ["Vacancy %", A.vacancyPct, B.vacancyPct], ["Open pipeline", A.openPipeline, B.openPipeline],
    ["Open roles", (A.tracker || {}).open || 0, (B.tracker || {}).open || 0],
    ["Ageing 90+", (A.tracker || {}).ageing90plus || 0, (B.tracker || {}).ageing90plus || 0],
    ["TAT breach", (A.tracker || {}).tatBreach || 0, (B.tracker || {}).tatBreach || 0],
    ["Attrition %", A.attrition, B.attrition], ["PMS goal %", (A.pms || {}).goalSetting, (B.pms || {}).goalSetting],
    ["Risk index", A.riskIndex, B.riskIndex],
    ["Training days", A.training ? A.training.trainingDays : null, B.training ? B.training.trainingDays : null],
  ];
  var g = $("#compareGrid"); g.innerHTML = "";
  rows.forEach(function (r, i) {
    if (i === 0) {
      g.appendChild(el("div", { class: "ch" }, r[0]));
      g.appendChild(el("div", { class: "ch" }, r[1]));
      g.appendChild(el("div", { class: "ch" }, r[2]));
      return;
    }
    var av = r[1], bv = r[2];
    var arrow = (av == null || bv == null) ? "" : av === bv ? "=" : av > bv ? " ▲" : " ▼";
    g.appendChild(el("div", {}, "<b>" + esc(r[0]) + "</b>"));
    g.appendChild(el("div", {}, fmt(av)));
    g.appendChild(el("div", {}, fmt(bv) + "<span class='diff muted'>" + arrow + "</span>"));
  });
  g.appendChild(el("div", { class: "note", style: "grid-column:1/-1" }, "Portfolio comparison — not individual performance comparison."));
}

/* =========================================================================
   GENERIC TABLE (search, sort, paginate, sticky, CSV, col-viz, row click)
   ========================================================================= */
var TBL = {};
function makeTable(sel, cols, rows, opts) {
  opts = opts || {};
  var id = opts.id || sel.replace(/\W/g, "");
  TBL[id] = { cols: cols, rows: rows, sort: -1, dir: 1, page: 0, per: 15, q: "", hidden: {}, opts: opts };
  var host = typeof sel === "string" ? $(sel) : sel;
  host.innerHTML =
    '<div class="tbl-tools"><input type="search" placeholder="Search…" data-t="' + id + '" class="tblSearch"/>' +
    '<button class="btn ghost btn-sm" data-csv="' + id + '">Export CSV</button>' +
    '<button class="btn ghost btn-sm" data-colviz="' + id + '">Columns</button></div>' +
    '<div class="colviz hidden" data-colvizbox="' + id + '"></div>' +
    '<div class="tbl-wrap" data-tblwrap="' + id + '"></div>' +
    '<div class="pager" data-pager="' + id + '"></div>';
  // col viz
  var box = $('[data-colvizbox="' + id + '"]', host);
  cols.forEach(function (c, ci) {
    var lab = el("label", {}, "<input type='checkbox' checked data-cv='" + id + "' data-ci='" + ci + "'/> " + esc(c || "—"));
    box.appendChild(lab);
  });
  drawTable(id, host);
}
function drawTable(id, host) {
  var t = TBL[id];
  var wrap = $('[data-tblwrap="' + id + '"]', host);
  var rows = t.rows.filter(function (r) {
    if (!t.q) return true;
    return r.some(function (c) { return String(c).toLowerCase().indexOf(t.q.toLowerCase()) >= 0; });
  });
  if (t.sort >= 0) {
    rows = rows.slice().sort(function (a, b) {
      var x = a[t.sort], y = b[t.sort];
      var nx = parseFloat(String(x).replace(/[^0-9.\-]/g, "")), ny = parseFloat(String(y).replace(/[^0-9.\-]/g, ""));
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * t.dir;
      return String(x).localeCompare(String(y)) * t.dir;
    });
  }
  var total = rows.length;
  var pages = Math.max(1, Math.ceil(total / t.per));
  if (t.page >= pages) t.page = pages - 1;
  var pageRows = rows.slice(t.page * t.per, (t.page + 1) * t.per);
  var degraded = (host.closest && host.closest("#ageTable")) ? [] : [];
  var html = "<table class='data'><thead><tr>";
  t.cols.forEach(function (c, ci) {
    if (t.hidden[ci]) return;
    html += "<th data-sort='" + ci + "'>" + esc(c || "") + (t.sort === ci ? (t.dir > 0 ? " ▲" : " ▼") : "") + "</th>";
  });
  html += "</tr></thead><tbody>";
  var raw = t.opts.raw || [];
  pageRows.forEach(function (r, ri) {
    html += "<tr data-ri='" + ri + "'>";
    r.forEach(function (c, ci) {
      if (t.hidden[ci]) return;
      html += "<td>" + (raw.indexOf(ci) >= 0 ? c : esc(c)) + "</td>";
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  wrap.innerHTML = html;
  // header sort
  $all("th[data-sort]", wrap).forEach(function (th) {
    th.onclick = function () {
      var ci = +th.dataset.sort;
      if (t.sort === ci) t.dir *= -1; else { t.sort = ci; t.dir = 1; }
      drawTable(id, host);
    };
  });
  // row click
  if (t.opts.rowClick) {
    $all("tbody tr", wrap).forEach(function (tr) {
      tr.onclick = function (e) { if (e.target.tagName === "SELECT") return; t.opts.rowClick(pageRows[+tr.dataset.ri]); };
    });
  }
  // status selects (actions)
  $all(".actStatus", wrap).forEach(function (s) {
    s.onchange = function () {
      var a = DATA.actions.filter(function (x) { return x.id === s.dataset.act; })[0];
      if (a) a.status = s.value;
    };
  });
  // pager
  var pg = $('[data-pager="' + id + '"]', host);
  pg.innerHTML = "<span class='muted'>" + total + " rows</span>" +
    "<button class='btn ghost btn-sm' data-pg='prev'>‹</button><span>" + (t.page + 1) + "/" + pages + "</span>" +
    "<button class='btn ghost btn-sm' data-pg='next'>›</button>";
  $('[data-pg="prev"]', pg).onclick = function () { if (t.page > 0) { t.page--; drawTable(id, host); } };
  $('[data-pg="next"]', pg).onclick = function () { if (t.page < pages - 1) { t.page++; drawTable(id, host); } };
}
// delegated table tool events
document.addEventListener("input", function (e) {
  if (e.target.classList && e.target.classList.contains("tblSearch")) {
    var id = e.target.dataset.t; TBL[id].q = e.target.value; TBL[id].page = 0;
    drawTable(id, e.target.closest(".section, .card, body"));
  }
});
document.addEventListener("click", function (e) {
  var t = e.target;
  if (t.dataset && t.dataset.csv) exportTableCSV(t.dataset.csv);
  if (t.dataset && t.dataset.colviz) { var b = $('[data-colvizbox="' + t.dataset.colviz + '"]'); b.classList.toggle("hidden"); }
  if (t.dataset && t.dataset.cv != null) {
    var id = t.dataset.cv, ci = +t.dataset.ci;
    TBL[id].hidden[ci] = !t.checked;
    drawTable(id, t.closest(".section, .card, body"));
  }
});
function exportTableCSV(id) {
  var t = TBL[id];
  var lines = [t.cols];
  t.rows.forEach(function (r) { lines.push(r.map(function (c) { return stripHtml(String(c)); })); });
  var csv = lines.map(function (l) { return l.map(csvCell).join(","); }).join("\n");
  download(id + "-export.csv", csv);
}
function csvCell(s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function stripHtml(s) { var d = el("div", {}, s); return d.textContent || ""; }

/* =========================================================================
   DRAWER / MODAL
   ========================================================================= */
function openDrawer(title, bodyHtml) {
  $("#drawerTitle").textContent = title;
  $("#drawerBody").innerHTML = bodyHtml;
  $("#drawer").classList.add("open");
  $("#overlay").classList.add("show");
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#overlay").classList.remove("show"); }
function openKpiDrawer(label) {
  var a = aggregate();
  var map = {
    "Vacancy Count": function () {
      var recs = filteredBudget().filter(function (r) { return r.occupancy === "Vacant"; }).slice(0, 100);
      return drawerMetrics([["Vacant positions", recs.length], ["Vacancy %", pct(a.vacancyPct)]]) +
        listHtml(recs.map(function (r) { return r.positionName + " — " + r.function + " · " + r.plant; }));
    },
    "Open Hiring Pipeline": function () {
      return drawerMetrics([["Open pipeline", a.openPipeline], ["Offered", a.offered], ["Joined YTD", a.joined]]) +
        "<p class='note'>Pipeline = WIP + To-Be-Offered + Offered, from the Monthly Review.</p>";
    },
    "Attrition %": function () {
      return drawerMetrics([["Attrition", pct(a.attrition)], ["Company avg", pct(weightedCompanyAttr())]]) +
        activePortfolios().map(function (p) { return "<p><b>" + esc(p.display) + ":</b> " + esc(p.attritionInsight || NA) + "</p>"; }).join("");
    },
  };
  var body = map[label] ? map[label]() :
    drawerMetrics([["Value", $("#kpiStrip .kpi") ? "" : ""]]) + "<p class='note'>" + esc(label) + " — drill-down detail.</p>";
  // generic fallback with the card's numbers
  if (!map[label]) {
    body = "<p class='note'>" + esc(label) + " for <b>" + esc(displayName()) + "</b>.</p>" +
      drawerMetrics([["Budget", fmt(a.budget)], ["Active", fmt(a.active)], ["Vacancy", fmt(a.vacancy)], ["Open pipeline", fmt(a.openPipeline)]]);
  }
  openDrawer(label, body);
}
function openSpeakupDrawer(m) {
  var rows = Object.keys(m.status || {}).map(function (h) { return h + ": " + (m.status[h] || "Pending"); });
  openDrawer("Speak-Up — " + m.milestone, listHtml(rows));
}
function openListDrawer(title, items) {
  openDrawer(title, items.length ? listHtml(items) : emptyState("No items."));
}
function drawerMetrics(pairs) {
  return '<div class="metrics">' + pairs.map(function (p) {
    return '<div class="m"><div class="v">' + esc(p[1]) + '</div><div class="l">' + esc(p[0]) + '</div></div>';
  }).join("") + "</div>";
}
function listHtml(items) {
  if (!items.length) return emptyState("No records.");
  return "<ul class='risk-list'>" + items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
}
function openRoleModal(roleId) {
  var r = (DATA.recruitmentRecords || []).filter(function (x) { return x.roleId === roleId; })[0];
  if (!r) return;
  var rag = ragAge(r.ageing);
  var pf = pById(r.portfolio);
  $("#modalTitle").innerHTML = esc(r.position !== NA ? r.position : roleId) + " " + dot(rag);
  $("#modalBody").innerHTML =
    "<dl class='kv'>" +
    kv("Role ref", roleId) + kv("HRBP", pf ? pf.display : NA) +
    kv("Function", r.function) + kv("Sub-function", r.subFunction) +
    kv("Location", r.location) + kv("Grade", r.grade) +
    kv("Status", r.status) + kv("Sourcing", r.sourcing) +
    kv("Recruitment type", r.positionType) + kv("Criticality", r.criticality) +
    kv("Budgeted year", r.budgetedYear) + kv("Approval", r.approval) +
    kv("Ageing", r.ageing != null ? r.ageing + " days (" + ragWord(rag) + ")" : NA) +
    kv("Ageing bucket", r.ageingBucket) +
    kv("Agreed TAT", r.agreedTat != null ? r.agreedTat + " days" : NA) +
    kv("TAT breach", r.tatBreach ? "Yes (ageing > agreed TAT)" : "No") +
    kv("Activation date", r.activationDate || NA) + kv("JD finalisation", r.jdDate || NA) +
    kv("Commitment date", r.commitmentDate || NA) + kv("Candidate joining", r.joiningDate || NA) +
    kv("Candidate", r.candidate || NA) +
    "</dl>";
  var bd = $("#modalBody");
  var bar = el("div", { style: "display:flex;gap:8px;margin-top:10px" });
  bar.appendChild(btn("Mark as Priority", function () { toast(roleId + " marked priority"); }));
  bar.appendChild(btn("Copy summary", function () { copy((r.position !== NA ? r.position : roleId) + " [" + (pf ? pf.display : "") + "]: " + r.function + " · " + r.location + " · status " + r.status + " · ageing " + r.ageing + "d · criticality " + r.criticality); }));
  bd.appendChild(bar);
  $("#modal").classList.add("open");
}
function kv(k, v) { return "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>"; }
function closeModal() { $("#modal").classList.remove("open"); }

/* =========================================================================
   SEARCH (debounced)
   ========================================================================= */
var searchTimer;
function onSearch(q) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () { doSearch(q); }, 180);
}
function doSearch(q) {
  var box = $("#searchResults");
  q = q.trim().toLowerCase();
  if (q.length < 2) { box.classList.add("hidden"); return; }
  var groups = { Roles: [], Actions: [], Initiatives: [], Training: [], "Data Quality": [] };
  (DATA.recruitmentRecords || []).forEach(function (r) {
    if ((r.roleId + " " + r.ageingBucket + " " + r.criticality + " " + r.positionType).toLowerCase().indexOf(q) >= 0 && groups.Roles.length < 6)
      groups.Roles.push({ t: r.roleId + " · " + r.ageing + "d · " + r.criticality, fn: function () { openRoleModal(r.roleId); go("sec-ageing"); } });
  });
  DATA.actions.forEach(function (a) {
    if ((a.theme + " " + a.recommendation + " " + a.hrbp).toLowerCase().indexOf(q) >= 0 && groups.Actions.length < 6)
      groups.Actions.push({ t: a.priority + " " + a.theme + " — " + a.hrbp, fn: function () { go("sec-actions"); } });
  });
  DATA.initiatives.forEach(function (i) {
    if (i.event.toLowerCase().indexOf(q) >= 0 && groups.Initiatives.length < 6)
      groups.Initiatives.push({ t: i.month + " · " + i.event, fn: function () { go("sec-initiatives"); } });
  });
  DATA.portfolios.forEach(function (p) {
    if (p.training && p.training.upcoming && p.training.upcoming.toLowerCase().indexOf(q) >= 0 && groups.Training.length < 4)
      groups.Training.push({ t: p.display + " · " + p.training.upcoming, fn: function () { go("sec-training"); } });
  });
  (DATA.dataQuality.issues || []).forEach(function (i) {
    if ((i.type + " " + i.detail).toLowerCase().indexOf(q) >= 0 && groups["Data Quality"].length < 4)
      groups["Data Quality"].push({ t: i.type, fn: function () { go("sec-dq"); } });
  });
  var html = "", any = false;
  Object.keys(groups).forEach(function (g) {
    if (!groups[g].length) return; any = true;
    html += "<div class='grp'>" + g + "</div>";
    groups[g].forEach(function (r, i) { html += "<div class='res' data-g='" + g + "' data-i='" + i + "'>" + esc(r.t) + "</div>"; });
  });
  box.innerHTML = any ? html : "<div class='res muted'>No matches</div>";
  box.classList.remove("hidden");
  $all(".res", box).forEach(function (r) {
    if (!r.dataset.g) return;
    r.onclick = function () { groups[r.dataset.g][+r.dataset.i].fn(); box.classList.add("hidden"); $("#globalSearch").value = ""; };
  });
}
function go(id) { showView(id); }

/* =========================================================================
   COPY / EXPORT / TOAST
   ========================================================================= */
/* ---------- print: executive summary page + one page per HRBP ---------- */
function buildPrint() {
  var root = $("#printRoot");
  if (DATA.meta.empty || !DATA.portfolios.length) {
    root.innerHTML = "<section class='print-page'><h1>No data loaded</h1><p>Upload your workbooks before printing.</p></section>";
    return;
  }
  var ps = DATA.portfolios, k = DATA.kpis, html = "";

  function kpiGrid(cards) {
    return "<div class='p-kpis'>" + cards.map(function (c) {
      return "<div class='p-kpi'><div class='v'>" + c[1] + "</div><div class='l'>" + esc(c[0]) + "</div></div>";
    }).join("") + "</div>";
  }
  function pHead(title, sub) {
    return "<div class='p-head'><div>" +
      "<div class='p-brand'>AM<span class='sl'>/</span>NS <span style='font-weight:500;font-size:9px;color:#cfcfcf'>ArcelorMittal Nippon Steel India</span></div>" +
      "<h1>" + esc(title) + "</h1><div class='p-sub'>" + esc(sub) + "</div></div>" +
      "<div class='p-meta'>" + esc(DATA.meta.title) + "<br/>Generated " + esc(DATA.meta.generatedAt) + "</div></div>";
  }
  var TAGLINE = "<span>SMARTER STEELS<b>.</b> BRIGHTER FUTURES<b>.</b></span>";

  // ----- Page 1: executive summary (whole org) -----
  html += "<section class='print-page'>";
  html += pHead("Executive Summary", DATA.meta.subtitle);
  html += kpiGrid([
    ["2026 Budget", fmt(k.budget)], ["Active headcount", fmt(k.active)],
    ["Vacancy", fmt(k.vacancy) + " (" + pct(k.vacancyPct) + ")"], ["Attrition", pct(k.attrition)],
    ["Joinings YTD", fmt(k.joiningsYTD)], ["Exits YTD", fmt(k.exitsYTD)],
    ["Net movement YTD", (k.netMovementYTD >= 0 ? "+" : "") + k.netMovementYTD], ["Open pipeline", fmt(k.openPipeline)],
  ]);
  html += "<h2>Portfolio comparison</h2><table class='p-tbl'><thead><tr>" +
    "<th>Portfolio</th><th>Budget</th><th>Active</th><th>Vacancy %</th><th>Attrition %</th>" +
    "<th>Open pipeline</th><th>90+ ageing</th><th>PMS goal %</th><th>Risk</th></tr></thead><tbody>";
  ps.forEach(function (p) {
    html += "<tr><td>" + esc(p.display) + "</td><td>" + fmt(p.budget) + "</td><td>" + fmt(p.active) +
      "</td><td>" + pct(p.vacancyPct) + "</td><td>" + pct(p.attrition) + "</td><td>" + fmt(p.openPipeline) +
      "</td><td>" + fmt((p.tracker || {}).ageing90plus || 0) + "</td><td>" + pct((p.pms || {}).goalSetting) +
      "</td><td>" + esc(p.riskBand || "—") + "</td></tr>";
  });
  html += "</tbody></table>";
  var topA = DATA.actions.slice(0, 8);
  if (topA.length) {
    html += "<h2>This month's priorities</h2><table class='p-tbl'><thead><tr><th>Priority</th><th>Portfolio</th>" +
      "<th>Theme</th><th>Recommended action</th><th>Owner</th></tr></thead><tbody>";
    topA.forEach(function (a) {
      html += "<tr><td>" + esc(a.priority) + "</td><td>" + esc(a.hrbp) + "</td><td>" + esc(a.theme) +
        "</td><td>" + esc(a.recommendation) + "</td><td>" + esc(a.owner) + "</td></tr>";
    });
    html += "</tbody></table>";
  }
  html += "<div class='p-foot'><span>Portfolio Risk Index is a workload/risk indicator — not an assessment of HRBP performance. Confidential: masked HR data.</span>" + TAGLINE + "</div></section>";

  // ----- One page per portfolio -----
  ps.forEach(function (p) {
    var trec = (DATA.recruitmentRecords || []).filter(function (x) { return x.portfolio === p.key; });
    function rt(key) { return r[key] ? r[key].total : 0; }
    var trecAgeing = ageingScope(trec);
    function tbk(bk) { return trecAgeing.filter(function (x) { return x.ageingBucket === bk; }).length; }
    function tst(st) { return trec.filter(function (x) { return x.status === st; }).length; }
    var r = p.recruitment || {};
    html += "<section class='print-page'>";
    html += pHead(p.display, "Portfolio one-page summary");
    html += kpiGrid([
      ["Budget", fmt(p.budget)], ["Active", fmt(p.active)],
      ["Vacancy", fmt(p.vacancy) + " (" + pct(p.vacancyPct) + ")"], ["Attrition", pct(p.attrition)],
      ["Joinings YTD", fmt(p.joiningsYTD)], ["Exits YTD", fmt(p.exitsYTD)],
      ["Open pipeline", fmt((p.tracker || {}).open || 0)], ["Risk", esc(p.riskBand || "—") + " (" + (p.riskIndex || 0) + ")"],
    ]);
    html += "<div class='p-cols'><div>";
    html += "<h3>Recruitment pipeline (live)</h3><table class='p-tbl'><tbody>" +
      "<tr><td>Yet to Start</td><td>" + tst("Yet to Start") + "</td></tr><tr><td>WIP</td><td>" + tst("WIP") + "</td></tr>" +
      "<tr><td>To Be Offered</td><td>" + tst("To Be Offered") + "</td></tr><tr><td>Offered</td><td>" + tst("Offered") + "</td></tr>" +
      "<tr><td>Joined</td><td>" + tst("Joined") + "</td></tr><tr><td>Hold</td><td>" + tst("Hold") + "</td></tr></tbody></table>";
    html += "<h3>Ageing (WIP + To Be Offered)</h3><table class='p-tbl'><tbody>" +
      "<tr><td>0–30</td><td>" + tbk("0-30") + "</td></tr><tr><td>31–60</td><td>" + tbk("31-60") + "</td></tr>" +
      "<tr><td>61–90</td><td>" + tbk("61-90") + "</td></tr><tr><td>91–120</td><td>" + tbk("91-120") + "</td></tr>" +
      "<tr><td>121+</td><td>" + tbk("121+") + "</td></tr><tr><td><b>TAT breach</b></td><td>" + ((p.tracker || {}).tatBreach || 0) + "</td></tr></tbody></table>";
    html += "</div><div>";
    html += "<h3>PMS &amp; capability</h3><table class='p-tbl'><tbody>" +
      "<tr><td>Goal setting</td><td>" + pct((p.pms || {}).goalSetting) + "</td></tr>" +
      "<tr><td>Mid-year</td><td>" + esc((p.pms || {}).midYear || "—") + "</td></tr>" +
      "<tr><td>End-year</td><td>" + esc((p.pms || {}).endYear || "—") + "</td></tr>" +
      "<tr><td>Training days</td><td>" + esc(p.training && p.training.trainingDays != null ? p.training.trainingDays : "—") + "</td></tr></tbody></table>";
    if ((p.criticalCases || []).length) {
      html += "<h3>Critical cases</h3><ol class='p-list'>" +
        p.criticalCases.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ol>";
    }
    html += "</div></div>";
    if (p.attritionInsight && p.attritionInsight !== NA) {
      html += "<div class='p-note'><b>Attrition insight:</b> " + esc(p.attritionInsight) + "</div>";
    }
    var pa = DATA.actions.filter(function (a) { return a.hrbp === p.display; });
    if (pa.length) {
      html += "<h3>Priorities</h3><table class='p-tbl'><thead><tr><th>Priority</th><th>Theme</th><th>Action</th><th>Owner</th></tr></thead><tbody>" +
        pa.map(function (a) { return "<tr><td>" + esc(a.priority) + "</td><td>" + esc(a.theme) + "</td><td>" + esc(a.recommendation) + "</td><td>" + esc(a.owner) + "</td></tr>"; }).join("") +
        "</tbody></table>";
    }
    html += "<div class='p-foot'><span>Confidential: masked HR data. Portfolio review — not an individual performance comparison.</span>" + TAGLINE + "</div></section>";
  });
  root.innerHTML = html;
}

function leadershipSummary() {
  var a = aggregate();
  var topFn = topN(countByField(trackerInScope(), "function"), 1)[0];
  var topActions = DATA.actions.filter(function (x) { return ST.hrbp === "all" || x.hrbp === displayName(); }).slice(0, 3);
  return "Portfolio review summary — " + displayName() + " (" + DATA.meta.generatedAt + "):\n" +
    "Vacancy " + pct(a.vacancyPct) + " (" + a.vacancy + " of " + a.budget + "). Live pipeline: " + a.trkOpen +
    " open roles; hiring demand highest in " + (topFn ? topFn[0] + " (" + topFn[1] + ")" : "n/a") + ". " +
    a.trkB90 + " roles ageing 90+ days, " + a.trkTatBreach + " past agreed TAT. Attrition " + pct(a.attrition) +
    " vs company " + pct(weightedCompanyAttr()) + ".\n" +
    "Immediate actions:\n" + (topActions.length ? topActions.map(function (x, i) { return (i + 1) + ". " + x.theme + " — " + x.recommendation + " (" + x.hrbp + ")"; }).join("\n") : "1. No threshold breaches.");
}
function copy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () { fallbackCopy(text); });
  else fallbackCopy(text);
}
function fallbackCopy(text) {
  var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); }
  document.body.removeChild(ta);
}
function download(name, content) {
  var blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  var a = el("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
var toastTimer;
function toast(msg) {
  var t = $("#toast") || el("div", { id: "toast", style: "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a2238;color:#fff;padding:10px 18px;border-radius:8px;z-index:200;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.3)" });
  t.textContent = msg; if (!t.parentNode) document.body.appendChild(t);
  t.style.opacity = "1"; clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.style.opacity = "0"; }, 1800);
}
function btn(label, fn) { var b = el("button", { class: "btn ghost btn-sm" }, label); b.onclick = fn; return b; }
function emptyState(msg, resetFn) {
  var html = "<div class='empty-state'>" + esc(msg);
  if (resetFn) html += "<br/><button class='btn ghost btn-sm' onclick='__resetEmpty()'>Reset</button>";
  window.__resetEmpty = resetFn || function () {};
  return html + "</div>";
}

/* =========================================================================
   KPI DEFINITIONS + SOURCE SUMMARY
   ========================================================================= */
function buildKpiDefs() {
  var defs = [
    ["Position Budget", "Approved 2026 positions (Monthly Review Headcount Overview)."],
    ["Active Headcount", "Employees currently on roll."],
    ["Vacancy", "Budget − Active."], ["Vacancy %", "Vacancy / Budget. G<10 · A 10–20 · R>20."],
    ["Open Pipeline", "WIP + To-Be-Offered + Offered."],
    ["Ageing", "Days a WIP role has been open (tracker numeric)."],
    ["Ageing Bucket", "Mutually-exclusive day ranges (each role in exactly one): 0-30 / 31-60 / 61-90 / 91-120 / 121+. Ageing is calculated only for WIP + To-Be-Offered roles."],
    ["TAT Breach", "A role whose ageing exceeds its own Agreed TAT (per row, from the Recruitment Tracker)."],
    ["Offer-to-Join", "Joined / Offered (note: Joined is YTD, Offered is a snapshot — ratio can exceed 100%)."],
    ["Closure Rate", "Joined / total pipeline."],
    ["Attrition %", "Exits over active (active-weighted at rollup). G<3 · A 3–5 · R>5."],
    ["Net Movement", "Joinings YTD − Exits YTD."],
    ["PMS Readiness", "Goal-setting completion. G≥95 · A 85–94 · R<85."],
    ["Engagement Watch", "Departments below company benchmark " + DATA.meta.benchmark + "."],
    ["Portfolio Risk Index", "Weighted workload/risk indicator (not performance)."],
    ["Data Quality Score", "Completeness over usable tracker fields."],
  ];
  var dl = $("#kpiDefs"); dl.innerHTML = "";
  defs.forEach(function (d) { dl.appendChild(el("dt", {}, d[0])); dl.appendChild(el("dd", {}, d[1])); });
}
function renderSourceSummary() {
  var m = DATA.meta;
  var html = "<table class='data'><tbody>" +
    tr("Generated", m.generatedAt) +
    tr("Sources", Object.values(m.sources).join(" · ")) +
    tr("Budget detail sheets used", (m.budgetSheetsUsed || []).join(", ")) +
    tr("Ignored / pivot sheets", (m.ignoredSheets || []).join(", ")) +
    tr("Privacy", m.privacyNote) +
    "</tbody></table>";
  var anyAlias = (m.hrbpMap || []).some(function (x) { return x.confidence !== "direct"; });
  html += "<h4 style='margin-top:14px;font-size:13px'>HRBP join (portfolio ← review label) " +
    (anyAlias ? "<span class='badge verify'>alias fallback in use</span>" : "<span class='badge' style='background:#e4f5ec;color:#1e8a5a;border-color:#bfe6d0'>direct name match</span>") + "</h4>";
  html += "<table class='data'><thead><tr><th>Portfolio</th><th>Review label</th><th>Budget sheet</th><th>Match</th></tr></thead><tbody>";
  m.hrbpMap.forEach(function (x) {
    var rag = x.confidence === "direct" ? "green" : x.confidence === "budget-only" ? "grey" : "amber";
    html += "<tr><td>" + esc(x.display) + "</td><td>" + esc(x.reviewLabel) + "</td><td>" + esc(x.budgetSheet) +
      "</td><td>" + pill(rag, x.confidence) + "</td></tr>";
  });
  html += "</tbody></table>";
  $("#sourceSummary").innerHTML = html;
}
function tr(k, v) { return "<tr><td style='font-weight:600;width:200px'>" + esc(k) + "</td><td>" + esc(v) + "</td></tr>"; }

/* =========================================================================
   VIEW MODE (executive vs analyst)
   ========================================================================= */
function applyView() {
  var analyst = ST.view === "analyst";
  $all(".analyst-only").forEach(function (n) { n.classList.toggle("hidden", !analyst); });
  $("#viewExec").classList.toggle("active", !analyst);
  $("#viewAnalyst").classList.toggle("active", analyst);
  $("#viewExec").setAttribute("aria-selected", String(!analyst));
  $("#viewAnalyst").setAttribute("aria-selected", String(analyst));
}

/* =========================================================================
   WIRING
   ========================================================================= */
function wireControls() {
  $("#hrbpSel").onchange = function () { setHrbp(this.value); };
  $("#scenarioSel").onchange = function () { ST.scenario = this.value; renderKpis(); renderStory(); };
  $("#viewExec").onclick = function () { ST.view = "exec"; applyView(); };
  $("#viewAnalyst").onclick = function () { ST.view = "analyst"; applyView(); };
  $("#btnReset").onclick = resetAll;
  var nt = $("#navToggle"); if (nt) nt.onclick = function () { document.body.classList.toggle("nav-open"); };
  $("#btnPrint").onclick = function () { buildPrint(); window.print(); };
  $("#btnCopySummary").onclick = function () { copy(leadershipSummary()); };
  var heroUp = $("#heroUpload");
  if (heroUp) heroUp.onclick = function () {
    var c = $("#dataLoad"); c.classList.add("open"); $(".c-head", c).setAttribute("aria-expanded", "true");
    c.scrollIntoView({ behavior: "smooth" });
  };
  $("#globalSearch").oninput = function () { onSearch(this.value); };
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search-wrap")) $("#searchResults").classList.add("hidden");
  });
  $("#btnCopyActions").onclick = function () {
    var acts = window.__filteredActions || DATA.actions;
    copy(acts.map(function (a) { return a.priority + " [" + a.hrbp + "] " + a.theme + ": " + a.recommendation; }).join("\n"));
  };
  $("#btnExportActions").onclick = function () {
    var acts = window.__filteredActions || DATA.actions;
    var csv = "Priority,HRBP,Theme,Issue,Evidence,Recommendation,Owner,Status\n" +
      acts.map(function (a) { return [a.priority, a.hrbp, a.theme, a.issue, a.evidence, a.recommendation, a.owner, a.status].map(csvCell).join(","); }).join("\n");
    download("monthly-actions.csv", csv);
  };
  ["actTheme", "actOwner", "actPriority"].forEach(function (id) { $("#" + id).onchange = renderActions; });
  $("#actRedOnly").onchange = renderActions;
  // drawer / modal close
  $("#drawerClose").onclick = closeDrawer;
  $("#overlay").onclick = closeDrawer;
  $("#modalClose").onclick = closeModal;
  $("#modal").onclick = function (e) { if (e.target === this) closeModal(); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeDrawer(); closeModal(); } });
  // collapsibles
  $all(".collapsible .c-head").forEach(function (h) {
    h.onclick = function () { var c = h.closest(".collapsible"); c.classList.toggle("open"); h.setAttribute("aria-expanded", c.classList.contains("open")); };
    h.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); h.click(); } };
  });
}

// boot
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", App.init);
else App.init();
window.App = App;
})();
