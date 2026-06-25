/* ==========================================================================
   HRBP Workforce & Recruitment Command Centre — app.js
   All dashboard logic. Pure browser, no build step, no network at runtime.
   Reads window.DASHBOARD_DATA (baked) and re-renders on filter/selector change.
   ========================================================================== */
(function () {
"use strict";

// ---------- state ----------
var DATA = window.DASHBOARD_DATA;          // active dataset (swappable via upload)
window.__setDashboardData = function (d) { DATA = d; App.fullRender(); };

var ST = {
  hrbp: "all",          // 'all' or portfolio key
  scenario: "current",
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
var RAG = {
  green: "#1e8a5a", amber: "#c79100", orange: "#d9710b",
  red: "#cc3340", darkred: "#8e1b27", grey: "#7a8699", blue: "#2d6cb5",
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

  // ----- Scenario Lens (simulated) -----
  var s = ST.scenario, simNote = null;
  var activeSim = a.active, vacSim = a.vacancy, pipeSim = a.openPipeline;
  if (s === "offered") { activeSim += a.offered; pipeSim -= a.offered; simNote = "If offered roles join"; }
  else if (s === "ojt") {
    var ojt = ps.reduce(function (n, p) { return n + ojtVacantCount(p); }, 0);
    activeSim += ojt; simNote = "If OJT confirmed (+" + ojt + ")";
  }
  else if (s === "hold") { pipeSim += a.onHold; activeSim += 0; simNote = "If hold roles released into pipeline (+" + a.onHold + ")"; }
  else if (s === "age90") { pipeSim -= a.b90; activeSim += a.b90; simNote = "If 90+ day roles closed (+" + a.b90 + ")"; }
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
    if (ST.filters.empType && r.employeeType !== ST.filters.empType) return false;
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
  buildScrollspy();
  buildQuickViews();
  buildFilterBar();
  buildKpiDefs();
  buildCompareSelectors();
  wireControls();
  renderSourceSummary();
  App.fullRender();
  setupScrollSpyObserver();
  applyView();
};

App.fullRender = function () {
  renderKpis();
  renderStory();
  renderComparison();
  renderHeadcount();
  renderFunnel();
  renderAgeing();
  renderCritical();
  renderAttrition();
  renderPms();
  renderEngagement();
  renderTraining();
  renderInitiatives();
  renderDataQuality();
  renderActions();
  renderCompare();
  renderFilterChips();
};

/* ---------- selectors / nav ---------- */
function buildHrbpSelector() {
  var sel = $("#hrbpSel");
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "all" }, "All HRBPs"));
  portfolios().forEach(function (p) {
    var o = el("option", { value: p.key }, p.display + (p.verify ? " ⚠" : ""));
    sel.appendChild(o);
  });
}
var SECTIONS = [
  ["sec-exec", "Executive Summary"], ["sec-compare", "HRBP Comparison"],
  ["sec-headcount", "Headcount & Budget"], ["sec-funnel", "Recruitment Funnel"],
  ["sec-ageing", "Ageing & TAT"], ["sec-critical", "Critical Cases"],
  ["sec-attrition", "Attrition & Movement"], ["sec-pms", "PMS"],
  ["sec-engagement", "Speak-Up"], ["sec-training", "Training"],
  ["sec-initiatives", "HR Initiatives"], ["sec-dq", "Data Quality"],
  ["sec-actions", "Monthly Actions"],
];
function buildScrollspy() {
  var nav = $("#scrollspy");
  SECTIONS.forEach(function (s) {
    var a = el("a", { href: "#" + s[0] }, s[1]);
    a.dataset.target = s[0];
    nav.appendChild(a);
  });
}
function setupScrollSpyObserver() {
  var links = $all("#scrollspy a");
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        links.forEach(function (l) { l.classList.toggle("active", l.dataset.target === en.target.id); });
      }
    });
  }, { rootMargin: "-130px 0px -65% 0px" });
  SECTIONS.forEach(function (s) { var n = document.getElementById(s[0]); if (n) obs.observe(n); });
}
var QUICKVIEWS = [
  ["Overall Health", "sec-exec", {}], ["Vacancy Pressure", "sec-headcount", {}],
  ["Ageing Risk", "sec-ageing", {}], ["Critical Roles", "sec-critical", {}],
  ["Attrition Watch", "sec-attrition", {}], ["PMS Readiness", "sec-pms", {}],
  ["Speak-Up Actions", "sec-engagement", {}], ["Training Coverage", "sec-training", {}],
  ["Data Quality", "sec-dq", {}], ["Monthly Actions", "sec-actions", {}],
];
function buildQuickViews() {
  var c = $("#quickViews");
  QUICKVIEWS.forEach(function (q) {
    var b = el("button", {}, q[0]);
    b.onclick = function () { document.getElementById(q[1]).scrollIntoView({ behavior: "smooth" }); };
    c.appendChild(b);
  });
}

/* ---------- C. filter bar ---------- */
var FILTER_DEFS = [
  { key: "function", label: "Function", from: "function" },
  { key: "location", label: "Location", from: "plant" },
  { key: "grade", label: "Grade", from: "_grade" },
  { key: "empType", label: "Position type", from: "employeeType" },
  { key: "occupancy", label: "Occupancy", from: "occupancy" },
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
      App.fullRender();
    };
    wrap.appendChild(sel);
    bar.appendChild(wrap);
  });
  // degraded-field disabled filters (honesty)
  ["Current Status", "Sourcing Channel", "Sub-function"].forEach(function (lbl) {
    var wrap = el("div", { class: "f" });
    wrap.appendChild(el("label", {}, lbl));
    var sel = el("select", { disabled: "true", title: "Degraded by source anonymisation — disabled" });
    sel.appendChild(el("option", {}, "Degraded — n/a"));
    wrap.appendChild(sel);
    bar.appendChild(wrap);
  });
  refreshFilterOptions();
}
function refreshFilterOptions() {
  var recs = (DATA.budgetRecords || []).filter(function (r) {
    return ST.hrbp === "all" || r.portfolio === ST.hrbp;
  });
  FILTER_DEFS.forEach(function (f) {
    var sel = $("#flt-" + f.key);
    if (!sel) return;
    var vals;
    if (f.key === "grade") vals = uniq(recs.map(function (r) { return gradeBand(r.grade); }));
    else vals = uniq(recs.map(function (r) { return r[f.from]; }));
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
      filteredBudget().length + " budget records match"));
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
    var card = el("div", { class: "kpi", tabindex: "0", role: "button" });
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
      " (net " + (a.joiningsYTD - a.exitsYTD) + "). Open pipeline is " + a.openPipeline +
      " with " + a.b90 + " roles ageing beyond 90 days.";
  } else {
    var p = ps[0];
    var lowEng = p.engagementLowestScore;
    lead = "<b>" + esc(p.display) + "</b> manages " + fmt(p.budget) + " budgeted positions, " +
      fmt(p.active) + " active — vacancy <b>" + fmt(p.vacancy) + "</b> (" + pct(p.vacancyPct) + ", " +
      ragWord(ragVacancy(p.vacancyPct)) + "). Recruitment movement: " + p.openPipeline + " in pipeline, " +
      p.joined + " joined YTD. Ageing risk: " + ((p.aging && p.aging.b90) || 0) + " roles 90+ days. Attrition <b>" +
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
    if (p.vacancyPct != null && p.vacancyPct > 20) out.push({ rag: "red", txt: p.display + ": vacancy " + pct(p.vacancyPct) });
    var b90 = (p.aging && p.aging.b90) || 0;
    if (b90 >= 10) out.push({ rag: "red", txt: p.display + ": " + b90 + " roles 90+ days" });
    if (p.attrition != null && p.attrition > 5) out.push({ rag: "red", txt: p.display + ": attrition " + pct(p.attrition) });
    if ((p.pms || {}).goalSetting != null && p.pms.goalSetting < 85) out.push({ rag: "amber", txt: p.display + ": PMS goal-setting " + pct(p.pms.goalSetting) });
  });
  if (!out.length) out.push({ rag: "green", txt: "No threshold breaches in current selection." });
  return out.slice(0, 7);
}

/* ---------- F. comparison charts ---------- */
function renderComparison() {
  var ps = DATA.portfolios;
  var labels = ps.map(function (p) { return p.display; });
  chart("chBudgetActive", {
    type: "bar",
    data: { labels: labels, datasets: [
      { label: "Budget", data: ps.map(function (p) { return p.budget; }), backgroundColor: "#9db8da" },
      { label: "Active", data: ps.map(function (p) { return p.active; }), backgroundColor: RAG.blue }] },
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
  insightCard(ic, "Largest gap", gapArr[0] ? gapArr[0].fn : "—", gapArr[0] ? gapArr[0].vac + " vacant (" + Math.round(gapArr[0].vacPct) + "%)" : "", "red");
  insightCard(ic, "Best-staffed function", bestFn ? bestFn.fn : "—", bestFn ? Math.round(bestFn.vacPct) + "% vacant" : "", "green");
  insightCard(ic, "Highest location risk", locArr[0] ? locArr[0].l : "—", locArr[0] ? Math.round(locArr[0].vacPct) + "% vacant" : "", "orange");
  insightCard(ic, "Records in view", fmt(recs.length), recs.filter(function (r) { return r.occupancy === "Vacant"; }).length + " vacant", "blue");

  // budget vs actual by function (top 12 by gap)
  var top = gapArr.slice(0, 12);
  chart("chFnGap", {
    type: "bar",
    data: { labels: top.map(function (x) { return x.fn; }), datasets: [
      { label: "Occupied", data: top.map(function (x) { return byFn[x.fn].occupied; }), backgroundColor: RAG.blue, stack: "s" },
      { label: "Vacant", data: top.map(function (x) { return byFn[x.fn].vacant; }), backgroundColor: "#e6a23c", stack: "s" }] },
    options: baseOpts({ x: { stacked: true, beginAtZero: true }, y: { stacked: true } }, "y"),
  });
  // occupied vs vacant donut
  var occ = recs.filter(function (r) { return r.occupancy === "Occupied"; }).length;
  var vac = recs.length - occ;
  chart("chOccVac", {
    type: "doughnut",
    data: { labels: ["Occupied", "Vacant"], datasets: [{ data: [occ, vac], backgroundColor: [RAG.blue, "#e6a23c"] }] },
    options: { plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: function (c) {
      return c.label + ": " + fmt(c.raw) + " (" + Math.round(c.raw / (occ + vac) * 100) + "%)"; } } } } },
  });
  // employee type
  var byType = countBy(recs, "employeeType");
  chart("chEmpType", {
    type: "bar",
    data: { labels: Object.keys(byType), datasets: [{ label: "Positions", data: Object.values(byType),
      backgroundColor: [RAG.blue, RAG.green, RAG.orange, RAG.grey, "#9b59b6"] }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  // grade pyramid
  var byGrade = countBy(recs.map(function (r) { return { g: gradeBand(r.grade) }; }).filter(function (r) { return r.g !== NA; }), "g");
  var gk = Object.keys(byGrade).sort();
  chart("chGrade", {
    type: "bar",
    data: { labels: gk, datasets: [{ label: "Positions", data: gk.map(function (k) { return byGrade[k]; }), backgroundColor: RAG.brand || "#2d6cb5" }] },
    options: baseOpts({ x: { beginAtZero: true } }, "y"),
  });
  renderHcHeat(recs);
  renderHcTable(gapArr, byFn);
}
function insightCard(parent, label, val, sub, rag) {
  parent.appendChild(el("div", { class: "card" },
    '<div class="k-label" style="font-size:10px;color:#5a6577">' + esc(label) + '</div>' +
    '<div style="font-size:17px;font-weight:800;margin:4px 0">' + dot(rag) + " " + esc(val) + '</div>' +
    '<div class="muted" style="font-size:11px">' + esc(sub) + '</div>'));
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
  var fns = Object.keys(groupSum(recs, "function")).slice(0, 14);
  var locs = uniq(recs.map(function (r) { return r.plant; })).filter(function (l) { return l && l !== NA; }).sort().slice(0, 10);
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

/* ---------- H. recruitment funnel ---------- */
function renderFunnel() {
  var ps = activePortfolios();
  var stages = { wip: 0, toBeOffered: 0, offered: 0, joined: 0 };
  var sourcing = { rpo: 0, consultant: 0, other: 0 };
  var offerDeclined = 0, hold = 0;
  ps.forEach(function (p) {
    ["wip", "toBeOffered", "offered", "joined", "offerDeclined"].forEach(function (k) {
      var d = p.recruitment[k]; if (!d) return;
      if (k === "offerDeclined") offerDeclined += d.total;
      else stages[k] += d.total;
      ["rpo", "consultant", "other"].forEach(function (s) { if (k !== "offerDeclined") sourcing[s] += d[s] || 0; });
    });
    hold += p.onHold || 0;
  });
  // metrics
  var fm = $("#funnelMetrics"); fm.innerHTML = "";
  var w2o = stages.wip ? Math.round(stages.offered / (stages.wip + stages.toBeOffered + stages.offered) * 100) : 0;
  insightCard(fm, "In pipeline", fmt(stages.wip + stages.toBeOffered + stages.offered), "WIP+ToBe+Offered", "blue");
  insightCard(fm, "Joined YTD", fmt(stages.joined), stages.offered + " currently offered", "green");
  insightCard(fm, "On hold / declined", fmt(hold) + " / " + fmt(offerDeclined), "Side states", "grey");
  insightCard(fm, "Offered → Joined", offerToJoinLabel(stages.joined, stages.offered), "YTD joins vs current offers", "amber");

  // funnel (horizontal bar descending)
  var fl = ["WIP", "To Be Offered", "Offered", "Joined"];
  var fv = [stages.wip, stages.toBeOffered, stages.offered, stages.joined];
  chart("chFunnel", {
    type: "bar",
    data: { labels: fl, datasets: [{ label: "Count", data: fv,
      backgroundColor: ["#9db8da", "#6c98c8", RAG.blue, RAG.green] }] },
    options: baseOpts({ x: { beginAtZero: true } }, "y", function (ctx) {
      var tot = fv[0] || 1; return ctx.raw + " roles · " + Math.round(ctx.raw / tot * 100) + "% of WIP"; }),
  });
  chart("chSourcing", {
    type: "doughnut",
    data: { labels: ["RPO", "Consultant", "Other (ER/TA/Internal)"], datasets: [{
      data: [sourcing.rpo, sourcing.consultant, sourcing.other], backgroundColor: [RAG.blue, RAG.orange, RAG.green] }] },
    options: { plugins: { legend: { position: "bottom" } } },
  });
  // stage by hrbp stacked
  var sp = DATA.portfolios;
  chart("chStageByHrbp", {
    type: "bar",
    data: { labels: sp.map(function (p) { return p.display; }), datasets: [
      ds("WIP", sp, "wip", "#9db8da"), ds("To Be Offered", sp, "toBeOffered", "#6c98c8"),
      ds("Offered", sp, "offered", RAG.blue), ds("Joined", sp, "joined", RAG.green)] },
    options: baseOpts({ x: { stacked: true }, y: { stacked: true, beginAtZero: true } }),
  });
  // position type & criticality from tracker
  var recs = trackerInScope();
  var byType = countByField(recs, "positionType");
  var byCrit = countByField(recs, "criticality");
  chart("chPosType", {
    type: "bar",
    data: { labels: ["New", "Replacement", "Crit 1", "Crit 2", "Crit 3"],
      datasets: [{ label: "Roles", data: [byType.New || 0, byType.Replacement || 0, byCrit["1"] || 0, byCrit["2"] || 0, byCrit["3"] || 0],
        backgroundColor: [RAG.green, RAG.blue, RAG.darkred, RAG.orange, RAG.amber] }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  function ds(label, arr, key, color) {
    return { label: label, data: arr.map(function (p) { return p.recruitment[key] ? p.recruitment[key].total : 0; }), backgroundColor: color };
  }
}
function offerToJoinLabel(joined, offered) {
  if (!offered) return "—";
  var r = Math.round(joined / offered * 100);
  return r > 100 ? "high (YTD>offer)" : r + "%";
}
function countByField(recs, key) { var g = {}; recs.forEach(function (r) { var v = r[key]; if (v && v !== NA) g[v] = (g[v] || 0) + 1; }); return g; }
function trackerInScope() { return DATA.recruitmentRecords || []; } // tracker has no usable HRBP key

/* ---------- I. ageing ---------- */
function renderAgeing() {
  var ps = DATA.portfolios;
  chart("chAgeBuckets", {
    type: "bar",
    data: { labels: ps.map(function (p) { return p.display; }), datasets: [
      bds("0-30", "b0_30", RAG.green), bds("30-60", "b30_60", RAG.amber),
      bds("60-90", "b60_90", RAG.orange), bds("90 +", "b90", RAG.red)] },
    options: baseOpts({ x: { stacked: true }, y: { stacked: true, beginAtZero: true } }),
  });
  function bds(label, key, color) { return { label: label, data: ps.map(function (p) { return (p.aging && p.aging[key]) || 0; }), backgroundColor: color }; }

  // numeric histogram from tracker
  var ages = (DATA.recruitmentRecords || []).map(function (r) { return r.ageing; }).filter(function (a) { return a != null; });
  var bins = [0, 30, 60, 90, 120, 9999], binLabels = ["0-30", "30-60", "60-90", "90-120", "120+"];
  var counts = binLabels.map(function () { return 0; });
  ages.forEach(function (a) { for (var i = 0; i < binLabels.length; i++) if (a <= bins[i + 1]) { counts[i]++; break; } });
  var tat = DATA.meta.tatAssumptionDays;
  chart("chAgeHist", {
    type: "bar",
    data: { labels: binLabels, datasets: [{ label: "Roles (n=" + ages.length + ")", data: counts,
      backgroundColor: [RAG.green, RAG.amber, RAG.orange, RAG.red, RAG.darkred] }] },
    options: baseOpts({ y: { beginAtZero: true } }, null, function (ctx) {
      return ctx.raw + " roles · " + Math.round(ctx.raw / ages.length * 100) + "% (TAT assumed " + tat + "d)"; }),
  });
  // top ageing roles table
  var top = (DATA.recruitmentRecords || []).filter(function (r) { return r.ageing != null; })
    .sort(function (a, b) { return b.ageing - a.ageing; }).slice(0, 50)
    .map(function (r) {
      return [r.roleId, r.ageing, r.ageingBucket, r.tatBreach ? "Breach" : "OK", r.criticality, r.positionType,
        r.joiningDate || "—"];
    });
  makeTable("#ageTable", ["Role ID", "Ageing (d)", "Bucket", "TAT", "Criticality", "Type", "Joining date"], top, { id: "age", rowClick: function (row) { openRoleModal(row[0]); } });
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
    data: { labels: MONTHS, datasets: [{ label: "Events", data: byMonth, backgroundColor: RAG.accent || "#6c4cd1" }] },
    options: baseOpts({ y: { beginAtZero: true } }),
  });
  var byCat = countByField(inits, "category");
  chart("chInitCat", {
    type: "doughnut",
    data: { labels: Object.keys(byCat), datasets: [{ data: Object.values(byCat),
      backgroundColor: [RAG.blue, RAG.green, RAG.orange, RAG.amber, RAG.red, "#6c4cd1"] }] },
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
  insightCard(m, "Completeness", dq.completeness + "%", "tracker numeric/criticality", dq.completeness > 70 ? "green" : dq.completeness > 40 ? "amber" : "red");
  insightCard(m, "Tracker rows", fmt(dq.trackerRows), "record-level (degraded)", "grey");
  insightCard(m, "Budget rows", fmt(dq.budgetRows), "record-level (usable)", "blue");
  insightCard(m, "Action-required issues", fmt(dq.actionRequired), "high severity", dq.actionRequired ? "red" : "green");
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
    ["Ageing 90+", (A.aging || {}).b90 || 0, (B.aging || {}).b90 || 0],
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
  $("#modalTitle").innerHTML = roleId + " " + dot(rag);
  $("#modalBody").innerHTML =
    "<dl class='kv'>" +
    kv("Ageing", r.ageing != null ? r.ageing + " days (" + ragWord(rag) + ")" : NA) +
    kv("Ageing bucket", r.ageingBucket) +
    kv("TAT breach", r.tatBreach ? "Yes (assumed TAT " + DATA.meta.tatAssumptionDays + "d)" : "No") +
    kv("Criticality", r.criticality) + kv("Position type", r.positionType) +
    kv("Activation date", r.activationDate || NA) + kv("JD finalisation", r.jdDate || NA) +
    kv("Commitment date", r.commitmentDate || NA) + kv("Candidate joining", r.joiningDate || NA) +
    kv("Candidate", r.candidate || NA) +
    "</dl>" +
    "<p class='note'>Function, grade, location, status &amp; sourcing are degraded by source anonymisation and shown as Not Available.</p>" +
    "<div style='display:flex;gap:8px;margin-top:10px'>" +
    "</div>";
  var bd = $("#modalBody");
  var bar = el("div", { style: "display:flex;gap:8px;margin-top:10px" });
  bar.appendChild(btn("Mark as Priority", function () { toast(roleId + " marked priority"); }));
  bar.appendChild(btn("Copy summary", function () { copy(roleId + ": ageing " + r.ageing + "d, " + r.ageingBucket + ", criticality " + r.criticality); }));
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
function go(id) { document.getElementById(id).scrollIntoView({ behavior: "smooth" }); }

/* =========================================================================
   COPY / EXPORT / TOAST
   ========================================================================= */
function leadershipSummary() {
  var a = aggregate();
  var worstFn = (function () {
    var g = groupSum(filteredBudget(), "function");
    return Object.keys(g).map(function (k) { return { k: k, v: g[k].vacant }; }).sort(function (x, y) { return y.v - x.v; })[0];
  })();
  var b90 = a.b90;
  var topActions = DATA.actions.filter(function (x) { return ST.hrbp === "all" || x.hrbp === displayName(); }).slice(0, 3);
  return "Portfolio review summary — " + displayName() + " (" + DATA.meta.generatedAt + "):\n" +
    "Vacancy " + pct(a.vacancyPct) + " (" + a.vacancy + " of " + a.budget + "); pressure highest in " +
    (worstFn ? worstFn.k : "n/a") + ". " + b90 + " roles ageing beyond 90 days. Attrition " + pct(a.attrition) +
    " vs company " + pct(weightedCompanyAttr()) + ". PMS goal-setting averaging low — cycle not yet initiated.\n" +
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
    ["Ageing Bucket", "0-30 / 30-60 / 60-90 / 90-120 / 120+."],
    ["TAT Breach", "Open beyond assumed TAT (" + DATA.meta.tatAssumptionDays + "d) — tracker TAT field is scrambled."],
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
  // analyst-only sections: tables in headcount/ageing already flagged; also show DQ table detail
  $("#viewExec").classList.toggle("active", !analyst);
  $("#viewAnalyst").classList.toggle("active", analyst);
  $("#viewExec").setAttribute("aria-selected", String(!analyst));
  $("#viewAnalyst").setAttribute("aria-selected", String(analyst));
  // hide heavy analyst sections in exec view
  ["sec-compare2"].forEach(function (id) { var n = document.getElementById(id); if (n) n.classList.toggle("hidden", !analyst); });
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
  $("#btnPrint").onclick = function () { window.print(); };
  $("#btnCopySummary").onclick = function () { copy(leadershipSummary()); };
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
