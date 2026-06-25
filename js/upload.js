/* ==========================================================================
   upload.js — OPTIONAL in-browser re-parse (secondary feature).
   Lazy-loads SheetJS only when the user actually uploads, so the default
   offline view never touches it. Mirrors build_data.py's section-aware
   parsing + masking. On any failure it falls back to baked data with a notice.
   ========================================================================== */
(function () {
"use strict";

var NA = "Not Available";
var TAT = 45;
// DATA-DRIVEN: portfolios come from the budget sheet names; review HRBPs are
// read from the sheet headers and joined by name. HRBP_ALIASES is only a
// fallback when a review label does not directly match a budget sheet name
// (kept here so the bundled demo still parses). Keep in sync with build_data.py.
var HRBP_ALIASES = { "aarav": "Dhruv", "kabir": "Shijumon", "riya": "Khyati", "nisha": "Chanchal", "meera": "Lincia" };
var SSC_FOLD = {};   // budget sheet name (lower) -> target portfolio display name
function slug(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "portfolio"; }

var baked = window.DASHBOARD_DATA;   // keep a reference to restore
var files = {};

// ---------- small helpers ----------
function norm(s) { return s == null ? "" : String(s).replace(/\s+/g, " ").trim(); }
function blank(v) { if (v == null) return true; var s = String(v).trim(); return s === "" || ["-", "NA", "N/A", "#REF!"].indexOf(s) >= 0; }
function num(v, d) { if (v == null) return d == null ? null : d; if (typeof v === "number") return v; var m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : (d == null ? null : d); }
function pctv(f) { if (f == null) return null; f = +f; return f <= 1 ? Math.round(f * 1000) / 10 : Math.round(f * 10) / 10; }

// ---------- masking (stable, non-reversible) ----------
function Masker() { this.e = {}; this.c = {}; this.m = {}; this.ne = 0; this.nc = 0; this.nm = 0; }
Masker.prototype.emp = function (r) { if (blank(r)) return null; var k = String(r).toLowerCase(); if (!this.e[k]) this.e[k] = "Employee Group " + (++this.ne); return this.e[k]; };
Masker.prototype.cand = function (r) { if (blank(r)) return null; var k = String(r).toLowerCase(); if (!this.c[k]) { var n = this.nc++, s = "", x = n; while (true) { s = String.fromCharCode(65 + x % 26) + s; x = Math.floor(x / 26) - 1; if (x < 0) break; } this.c[k] = "Candidate " + s; } return this.c[k]; };

// ---------- SheetJS lazy loader ----------
var XLSXP = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (XLSXP) return XLSXP;
  XLSXP = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = "./vendor/xlsx.full.min.js";
    s.onload = function () { resolve(window.XLSX); };
    s.onerror = function () { reject(new Error("Could not load vendored SheetJS")); };
    document.head.appendChild(s);
  });
  return XLSXP;
}
function readBook(file) {
  return file.arrayBuffer().then(function (buf) {
    return window.XLSX.read(buf, { type: "array", cellDates: true });
  });
}
function sheetRows(wb, name) {
  var ws = wb.Sheets[name];
  // openpyxl indexes from column A; SheetJS trims leading empty columns, which
  // would shift our anchor-based column indices. Force the range to start at A1
  // so column indices match build_data.py exactly.
  if (ws && ws["!ref"]) {
    var rng = window.XLSX.utils.decode_range(ws["!ref"]);
    rng.s.c = 0; rng.s.r = 0;
    ws = Object.assign({}, ws, { "!ref": window.XLSX.utils.encode_range(rng) });
  }
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}
function findSheet(wb, hints) {
  var names = wb.SheetNames;
  for (var i = 0; i < hints.length; i++) {
    var h = hints[i].trim().toLowerCase();
    for (var j = 0; j < names.length; j++) if (names[j].trim().toLowerCase() === h) return names[j];
  }
  for (var i2 = 0; i2 < hints.length; i2++) {
    var h2 = hints[i2].trim().toLowerCase();
    for (var j2 = 0; j2 < names.length; j2++) { var lo = names[j2].trim().toLowerCase(); if (lo.indexOf(h2) >= 0 || h2.indexOf(lo) >= 0) return names[j2]; }
  }
  return null;
}

/* ============================ REVIEW PARSER ============================ */
function parseReview(wb, MASK) {
  var sn = findSheet(wb, ["Summary"]);
  var rows = sheetRows(wb, sn);
  function cell(r, c) { return (rows[r] && rows[r][c] != null) ? rows[r][c] : null; }
  function secRow(label) { for (var i = 0; i < rows.length; i++) if (norm(cell(i, 1)).toLowerCase() === label.toLowerCase()) return i; return -1; }
  function rowLabel(i) { return norm(cell(i, 2)); }
  // Discover HRBP names from a section header row (span=1 normally; 3 in Recruitment).
  function readHrbpHeader(headerRow, span, startCol) {
    span = span || 1; var c = startCol || 3, pairs = [];
    while (c < 40) {
      var v = norm(cell(headerRow, c));
      if (!v || v.toLowerCase() === "total" || v.toLowerCase() === "grand total") break;
      pairs.push([v, c]); c += span;
    }
    return pairs;
  }
  var out = { hrbps: {}, engagement: [], initiatives: [], benchmark: null, speakUpMilestones: [], hrbpNames: [] };

  // headcount (authoritative HRBP name list)
  var hc = secRow("Headcount Overview");
  var hcPairs = hc >= 0 ? readHrbpHeader(hc + 1) : [];
  var REVIEW_HRBPS = hcPairs.map(function (p) { return p[0]; });
  out.hrbpNames = REVIEW_HRBPS;
  var hcCols = {}; hcPairs.forEach(function (p) { hcCols[p[0]] = p[1]; });
  REVIEW_HRBPS.forEach(function (h) { out.hrbps[h] = {}; });
  var hcF = [["Total Position 2026", "budget"], ["Active Employees", "active"], ["Joining's in June", "joiningsJune"],
    ["Exits in June", "exitsJune"], ["Joining's YTD", "joiningsYTD"], ["Exits YTD", "exitsYTD"],
    ["Current Positions", "wipCurrent"], ["Future Positions", "future"], ["On Hold", "onHold"],
    ["Delimit/Redundant", "delimit"], ["Attrition %", "attrition"], ["Insights on Attrition", "attritionInsight"]];
  if (hc >= 0) for (var i = hc + 1; i < hc + 16; i++) {
    var lbl = rowLabel(i); if (!lbl) continue;
    hcF.forEach(function (f) {
      if (lbl.toLowerCase().indexOf(f[0].toLowerCase()) >= 0) {
        Object.keys(hcCols).forEach(function (h) {
          var v = cell(i, hcCols[h]);
          if (f[1] === "attrition") out.hrbps[h][f[1]] = pctv(num(v));
          else if (f[1] === "attritionInsight") out.hrbps[h][f[1]] = blank(v) ? NA : norm(v);
          else out.hrbps[h][f[1]] = num(v) != null ? Math.round(num(v)) : null;
        });
      }
    });
  }
  // recruitment
  var rec = secRow("Recruitment Overview");
  var recF = { "wip": "wip", "offered": "offered", "to be offered": "toBeOffered", "joined 2026": "joined", "offer declined": "offerDeclined" };
  var recCols = {}; if (rec >= 0) readHrbpHeader(rec + 1, 3).forEach(function (p) { recCols[p[0]] = p[1]; });
  REVIEW_HRBPS.forEach(function (h) { out.hrbps[h].recruitment = {}; });
  if (rec >= 0) for (var ri = rec + 1; ri < rec + 9; ri++) {
    var l = rowLabel(ri).toLowerCase(); var field = recF[l]; if (!field) continue;
    Object.keys(recCols).forEach(function (h) {
      var c0 = recCols[h], rpo = num(cell(ri, c0)) || 0, co = num(cell(ri, c0 + 1)) || 0, ot = num(cell(ri, c0 + 2)) || 0;
      out.hrbps[h].recruitment[field] = { rpo: rpo, consultant: co, other: ot, total: rpo + co + ot };
    });
  }
  // aging
  var ag = secRow("Aging Overview");
  var agCols = {}; if (ag >= 0) readHrbpHeader(ag + 1).forEach(function (p) { agCols[p[0]] = p[1]; });
  var agF = { "wip": "wip", "0-30": "b0_30", "30-60": "b30_60", "60-90": "b60_90", "90 +": "b90" };
  REVIEW_HRBPS.forEach(function (h) { out.hrbps[h].aging = {}; });
  if (ag >= 0) for (var ai = ag + 1; ai < ag + 9; ai++) {
    var al = rowLabel(ai); if (!al) continue;
    if (al.toLowerCase().indexOf("critical") >= 0) {
      Object.keys(agCols).forEach(function (h) {
        var txt = cell(ai, agCols[h]);
        out.hrbps[h].criticalCases = blank(txt) ? [] : String(txt).split(/\s*\d+\.\s*/).map(norm).filter(Boolean);
      });
      continue;
    }
    Object.keys(agF).forEach(function (k) {
      if (k.replace(/\s/g, "") === al.replace(/\s/g, "")) Object.keys(agCols).forEach(function (h) { out.hrbps[h].aging[agF[k]] = num(cell(ai, agCols[h])) || 0; });
    });
  }
  // initiatives
  var init = secRow("HR Initiatives Calendar");
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  if (init >= 0) {
    var end = secRow("Training & Development"); if (end < 0) end = init + 40;
    var cur = null;
    for (var ii = init + 2; ii < end; ii++) {
      var rl = norm(cell(ii, 2));
      if (rl) { for (var h = 0; h < REVIEW_HRBPS.length; h++) if (rl.toLowerCase().indexOf(REVIEW_HRBPS[h].toLowerCase()) >= 0) { cur = REVIEW_HRBPS[h]; break; } }
      for (var mi = 0; mi < 12; mi++) {
        var v = cell(ii, 3 + mi);
        if (!blank(v)) { var t = norm(v); if (t && t.toLowerCase().indexOf("dummy business note") !== 0) out.initiatives.push({ hrbp: cur || NA, month: MONTHS[mi], event: t, category: classify(t) }); }
      }
    }
  }
  // training
  var tr = secRow("Training & Development");
  if (tr >= 0) {
    var te = secRow("Org Charts"); if (te < 0) te = tr + 10;
    var trRows = [];
    for (var ti = tr + 2; ti < te; ti++) {
      var tot = num(cell(ti, 3)); if (tot == null) continue;
      var d = num(cell(ti, 9));
      trRows.push({ rowLabel: norm(cell(ti, 2)), totalHeadcount: Math.round(tot), trainingDays: d != null ? Math.round(d * 100) / 100 : null, upcoming: norm(cell(ti, 10)) || NA });
    }
    REVIEW_HRBPS.forEach(function (h) { for (var k = 0; k < trRows.length; k++) if (trRows[k].rowLabel.toLowerCase().indexOf(h.toLowerCase()) >= 0) { out.hrbps[h].training = trRows[k]; break; } });
    if (REVIEW_HRBPS.length && !out.hrbps[REVIEW_HRBPS[0]].training && trRows.length) out.hrbps[REVIEW_HRBPS[0]].training = trRows[0];
  }
  // pms
  var pms = secRow("PMS");
  if (pms >= 0) for (var pi = pms + 1; pi < pms + 8; pi++) {
    var pl = norm(cell(pi, 2));
    REVIEW_HRBPS.forEach(function (h) { if (pl.toLowerCase() === h.toLowerCase()) out.hrbps[h].pms = { goalSetting: pctv(num(cell(pi, 3))), midYear: norm(cell(pi, 4)) || NA, endYear: norm(cell(pi, 5)) || NA }; });
  }
  // speakup
  var su = -1; for (var s1 = 0; s1 < rows.length; s1++) { var t1 = norm(cell(s1, 1)).toLowerCase(); if (t1.indexOf("speak") >= 0 && t1.indexOf("up") >= 0) { su = s1; break; } }
  if (su >= 0) {
    var suCols = {}; readHrbpHeader(su + 1).forEach(function (p) { REVIEW_HRBPS.forEach(function (h) { if (p[0].toLowerCase() === h.toLowerCase()) suCols[h] = p[1]; }); });
    for (var mi2 = su + 2; mi2 < su + 12; mi2++) {
      var ml = norm(cell(mi2, 2)); if (!ml) continue; if (ml.toLowerCase().indexOf("employee listening") >= 0) break;
      var st = {}; Object.keys(suCols).forEach(function (h) { var v = norm(cell(mi2, suCols[h])); st[h] = v || "Pending"; });
      out.speakUpMilestones.push({ milestone: ml, status: st });
    }
  }
  // engagement
  var el = -1; for (var e1 = 0; e1 < rows.length; e1++) { if (norm(cell(e1, 1)).toLowerCase().indexOf("employee listening scores") >= 0 || norm(cell(e1, 2)).toLowerCase().indexOf("employee listening scores") >= 0) { el = e1; break; } }
  if (el >= 0) {
    var curH = NA;
    for (var ei = el + 1; ei < rows.length; ei++) {
      var hc2 = norm(cell(ei, 1)), dept = norm(cell(ei, 2)), sc = cell(ei, 3);
      if (hc2 && hc2.toLowerCase() === "hrbp") continue;
      if (hc2 && hc2.toLowerCase() !== "hrbp") curH = hc2;
      if (dept.toLowerCase() === "demo steel india") { out.benchmark = num(sc); continue; }
      if (blank(dept) || dept.length > 60) continue;
      var score = num(sc);
      out.engagement.push({ hrbp: curH, department: dept, score: score, scoreLabel: score != null ? String(Math.round(score * 100) / 100) : NA });
    }
  }
  return out;
}
function classify(text) {
  var t = text.toLowerCase();
  var cats = [["Compliance", ["compliance", "safety", "ethics", "posh", "audit", "governance"]],
    ["Pms", ["goal", "performance", "appraisal", "review", "commitment"]],
    ["Capability", ["learning", "awareness", "training", "workshop", "capability", "synergy", "leadership"]],
    ["Communication", ["connect", "feedback", "communication", "interaction", "town", "quarterly"]],
    ["Engagement", ["engagement", "recognition", "reward", "festival", "celebration", "wellbeing", "health", "games", "lunch", "donation", "felicitation", "farewell"]]];
  for (var i = 0; i < cats.length; i++) for (var j = 0; j < cats[i][1].length; j++) if (t.indexOf(cats[i][1][j]) >= 0) return cats[i][0];
  return "Culture";
}

/* ============================ BUDGET PARSER ============================ */
var BSYN = { "function plant": "plant", "function 1": "function", "department": "department", "sub department": "subDepartment",
  "position lvl": "positionLevel", "position id": "positionId", "position name": "positionName", "emp. code": "_c", "emp. name": "_n",
  "employee grade": "grade", "employee level": "grade", "regular / trainee": "employeeType", "regular/trainee": "employeeType",
  "vacant/occupied": "occupancy", "occupied/vacant": "occupancy", "remarks": "remarks" };
function mapHeader(h) {
  var k = norm(h).toLowerCase(); if (BSYN[k]) return BSYN[k];
  if (k.indexOf("sub") >= 0 && k.indexOf("department") >= 0) return "subDepartment";
  if (k.indexOf("grade") >= 0 || k.indexOf("level") >= 0) return "grade";
  if (k.indexOf("vacant") >= 0 || k.indexOf("occupied") >= 0) return "occupancy";
  if (k.indexOf("regular") >= 0 || k.indexOf("trainee") >= 0) return "employeeType";
  if (k.indexOf("plant") >= 0) return "plant";
  if (k.indexOf("position name") >= 0) return "positionName";
  if (k.indexOf("emp") >= 0 && k.indexOf("name") >= 0) return "_n";
  return null;
}
function empType(v, isOjt) { if (isOjt) return "OJT"; if (blank(v)) return "Regular"; var s = String(v).toLowerCase(); if (s.indexOf("ojt") >= 0) return "OJT"; if (s.indexOf("trainee") >= 0) return "Trainee"; if (s.indexOf("contract") >= 0 || s.indexOf("bpo") >= 0) return "Contractual"; return "Regular"; }
function occVal(v, name) { if (!blank(v)) { var s = String(v).toLowerCase(); if (s.indexOf("occup") >= 0) return "Occupied"; if (s.indexOf("vacant") >= 0) return "Vacant"; } return blank(name) ? "Vacant" : "Occupied"; }
function parseBudget(wb, MASK) {
  // DATA-DRIVEN: each detail sheet is a portfolio named after the sheet.
  var fold = {}; Object.keys(SSC_FOLD).forEach(function (k) { fold[k.trim().toLowerCase()] = SSC_FOLD[k]; });
  var records = [], used = [], ignored = [], portfolioDisplay = {};
  wb.SheetNames.forEach(function (sn) {
    var lo = sn.trim().toLowerCase();
    if (lo.indexOf("summary") >= 0) { ignored.push(sn); return; }
    var rows = sheetRows(wb, sn); if (!rows.length) { ignored.push(sn); return; }
    var hi = -1;
    for (var i = 0; i < Math.min(6, rows.length); i++) { var joined = (rows[i] || []).map(function (c) { return norm(c).toLowerCase(); }).join(" "); if (joined.indexOf("position") >= 0 && (joined.indexOf("emp") >= 0 || joined.indexOf("function") >= 0)) { hi = i; break; } }
    if (hi < 0) { ignored.push(sn); return; }       // not a record sheet
    var display = fold[lo] || sn.trim(), pf = slug(display), isOjt = lo.indexOf("ojt") >= 0;
    if (!(pf in portfolioDisplay)) portfolioDisplay[pf] = display;
    var colmap = {}; (rows[hi] || []).forEach(function (h, ci) { var f = mapHeader(h); if (f && !(f in colmap)) colmap[f] = ci; });
    for (var r = hi + 1; r < rows.length; r++) {
      var row = rows[r] || []; if (!row.some(function (c) { return !blank(c); })) continue;
      function g(f) { var ci = colmap[f]; return ci != null ? row[ci] : null; }
      if (blank(g("positionName")) && blank(g("positionId"))) continue;
      var name = g("_n"), occ = occVal(g("occupancy"), name);
      records.push({ portfolio: pf, plant: norm(g("plant")) || NA, "function": norm(g("function")) || NA,
        department: norm(g("department")) || NA, subDepartment: norm(g("subDepartment")) || NA,
        positionLevel: norm(g("positionLevel")) || NA, positionName: norm(g("positionName")) || NA,
        grade: norm(g("grade")) || NA, employeeType: empType(g("employeeType"), isOjt),
        occupancy: occ, holder: occ === "Occupied" ? MASK.emp(name) : null, remarks: norm(g("remarks")) || "" });
    }
    used.push(sn);
  });
  return { records: records, used: used, ignored: ignored, portfolioDisplay: portfolioDisplay };
}

/* ============================ TRACKER PARSER ============================ */
function parseTracker(wb, MASK) {
  var sn = findSheet(wb, ["Recruitment Tracker ", "Recruitment Tracker"]);
  var ignored = wb.SheetNames.filter(function (s) { return s !== sn; });
  var rows = sn ? sheetRows(wb, sn) : [];
  var hdr = rows[0] || [], idx = {}; hdr.forEach(function (h, i) { idx[norm(h).toLowerCase()] = i; });
  function col(hint) { for (var k in idx) if (k.indexOf(hint) >= 0) return idx[k]; return null; }
  var iAge = idx["ageing"] != null ? idx["ageing"] : col("ageing");
  var iCode = col("position code"), iCand = col("candidate name"), iAct = col("hiring activation"), iJd = col("jd finalisation"),
    iCommit = col("commitment date"), iJoin = col("candidate joining"), iRepl = col("replacement"), iCrit = col("criticality");
  function dIso(v) { if (v instanceof Date) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0"); return null; }
  var records = [], ages = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r] || []; if (!row.some(function (c) { return !blank(c); })) continue;
    function g(i) { return i != null ? row[i] : null; }
    var age = num(g(iAge)); if (age != null) ages.push(age);
    var rep = norm(g(iRepl)); rep = rep.toLowerCase() === "new" ? "New" : (rep.toLowerCase().indexOf("replac") >= 0 ? "Replacement" : NA);
    var cr = norm(g(iCrit)); cr = ["1", "2", "3"].indexOf(cr) >= 0 ? cr : NA;
    records.push({ roleId: "Role " + String(r).padStart(4, "0"), ageing: age != null ? Math.round(age) : null,
      ageingBucket: bucket(age), tatBreach: age != null && age > TAT, positionType: rep, criticality: cr,
      activationDate: dIso(g(iAct)), jdDate: dIso(g(iJd)), commitmentDate: dIso(g(iCommit)), joiningDate: dIso(g(iJoin)),
      candidate: MASK.cand(g(iCand)), degraded: true });
  }
  return { records: records, ages: ages, used: sn ? [sn] : [], ignored: ignored };
}
function bucket(a) { if (a == null) return NA; a = +a; return a <= 30 ? "0-30" : a <= 60 ? "30-60" : a <= 90 ? "60-90" : a <= 120 ? "90-120" : "120+"; }

/* ============================ RECONCILE + ASSEMBLE ============================ */
function reconcile(review, portfolioDisplay) {
  var nameToKey = {}; Object.keys(portfolioDisplay).forEach(function (k) { nameToKey[portfolioDisplay[k].trim().toLowerCase()] = k; nameToKey[k] = k; });
  var descriptors = {};
  (review.hrbpNames || []).forEach(function (L) {
    var target = HRBP_ALIASES[L.trim().toLowerCase()] || L;
    var k = nameToKey[target.trim().toLowerCase()] || nameToKey[slug(target)];
    var conf;
    if (k == null) { k = slug(L); portfolioDisplay[k] = portfolioDisplay[k] || L; conf = "review-only"; }
    else { conf = (L.trim().toLowerCase() === (portfolioDisplay[k] || "").trim().toLowerCase()) ? "direct" : "alias"; }
    descriptors[k] = { key: k, display: portfolioDisplay[k] || L, reviewLabel: L, budgetSheet: portfolioDisplay[k] || NA, confidence: conf, verify: false };
  });
  Object.keys(portfolioDisplay).forEach(function (k) {
    if (!descriptors[k]) descriptors[k] = { key: k, display: portfolioDisplay[k], reviewLabel: null, budgetSheet: portfolioDisplay[k], confidence: "budget-only", verify: false };
  });
  return descriptors;
}
function assemble(review, budget) {
  var byPf = {}; budget.records.forEach(function (r) { (byPf[r.portfolio] = byPf[r.portfolio] || []).push(r); });
  var descriptors = reconcile(review, budget.portfolioDisplay);
  var ordered = Object.keys(descriptors).map(function (k) { return descriptors[k]; }).sort(function (a, b) {
    var ra = review.hrbps[a.reviewLabel] || {}, rb = review.hrbps[b.reviewLabel] || {};
    return (rb.budget || 0) - (ra.budget || 0) || (byPf[b.key] || []).length - (byPf[a.key] || []).length;
  });
  review._descriptors = ordered;
  var portfolios = ordered.map(function (m) {
    var pkey = m.key, rl = m.reviewLabel, rv = (rl && review.hrbps[rl]) || {}, recs = byPf[pkey] || [];
    var budgetN = rv.budget, active = rv.active, vac = (budgetN != null && active != null) ? budgetN - active : null;
    var rec = rv.recruitment || {};
    function rs(k) { return rec[k] ? rec[k].total : 0; }
    var openP = rs("wip") + rs("toBeOffered") + rs("offered"), offered = rs("offered"), joined = rs("joined");
    var totFun = openP + joined + rs("offerDeclined");
    var aging = rv.aging || {}, wip = aging.wip || 0, b90 = aging.b90 || 0;
    var pms = rv.pms || {}, goal = pms.goalSetting;
    var eng = review.engagement.filter(function (e) { return rl && e.hrbp && e.hrbp.toLowerCase() === rl.toLowerCase() && e.score != null; });
    var lowest = eng.length ? eng.reduce(function (a, b) { return a.score < b.score ? a : b; }) : null;
    return { key: pkey, display: m.display, reviewLabel: rl, budgetSheet: m.budgetSheet, confidence: m.confidence, verify: m.verify,
      budget: budgetN, active: active, vacancy: vac, vacancyPct: (vac != null && budgetN) ? Math.round(vac / budgetN * 1000) / 10 : null,
      joiningsJune: rv.joiningsJune, exitsJune: rv.exitsJune, joiningsYTD: rv.joiningsYTD, exitsYTD: rv.exitsYTD,
      netMovementYTD: (rv.joiningsYTD || 0) - (rv.exitsYTD || 0), future: rv.future, onHold: rv.onHold, delimit: rv.delimit,
      attrition: rv.attrition, attritionInsight: rv.attritionInsight || NA, recruitment: rec,
      openPipeline: openP, offered: offered, joined: joined,
      offerToJoin: offered ? Math.round(joined / offered * 1000) / 10 : null,
      closureRate: totFun ? Math.round(joined / totFun * 1000) / 10 : null,
      aging: aging, tatBreachPct: wip ? Math.round(b90 / wip * 1000) / 10 : null, criticalCases: rv.criticalCases || [],
      pms: pms, pmsPending: goal != null ? Math.round((100 - goal) * 10) / 10 : null,
      training: rv.training, orgChart: rv.orgChart || NA,
      engagementLowest: lowest ? lowest.department : NA, engagementLowestScore: lowest ? lowest.score : null,
      budgetRecordCount: recs.length, occupiedRecords: recs.filter(function (r) { return r.occupancy === "Occupied"; }).length,
      vacantRecords: recs.filter(function (r) { return r.occupancy === "Vacant"; }).length };
  });
  // risk index
  function safe(v, d) { return v != null ? v : (d || 0); }
  var maxVac = Math.max.apply(null, portfolios.map(function (p) { return safe(p.vacancyPct); }).concat([1]));
  var maxAge = Math.max.apply(null, portfolios.map(function (p) { return safe(p.aging.b90); }).concat([1]));
  var maxAttr = Math.max.apply(null, portfolios.map(function (p) { return safe(p.attrition); }).concat([1]));
  var maxLoad = Math.max.apply(null, portfolios.map(function (p) { return safe(p.openPipeline); }).concat([1]));
  var maxPms = Math.max.apply(null, portfolios.map(function (p) { return safe(p.pmsPending); }).concat([1]));
  var bench = review.benchmark || 6.19;
  portfolios.forEach(function (p) {
    var engGap = Math.max(0, bench - safe(p.engagementLowestScore, bench));
    var idx = 25 * safe(p.vacancyPct) / maxVac + 25 * safe(p.aging.b90) / maxAge + 20 * safe(p.attrition) / maxAttr +
      15 * safe(p.openPipeline) / maxLoad + 10 * safe(p.pmsPending) / maxPms + 5 * (engGap / Math.max(bench, 1));
    p.riskIndex = Math.round(idx * 10) / 10; p.riskBand = idx >= 60 ? "High" : idx >= 35 ? "Moderate" : "Low";
  });
  return portfolios;
}
function rollup(portfolios, review) {
  function s(f) { return portfolios.reduce(function (n, p) { return n + (p[f] || 0); }, 0); }
  var budget = s("budget"), active = s("active"), vac = budget - active;
  var totA = portfolios.reduce(function (n, p) { return n + (p.active || 0); }, 0) || 1;
  var attr = Math.round(portfolios.reduce(function (n, p) { return n + (p.attrition || 0) * (p.active || 0); }, 0) / totA * 10) / 10;
  return { budget: budget, active: active, vacancy: vac, vacancyPct: budget ? Math.round(vac / budget * 1000) / 10 : null,
    joiningsYTD: s("joiningsYTD"), exitsYTD: s("exitsYTD"), netMovementYTD: s("joiningsYTD") - s("exitsYTD"),
    attrition: attr, openPipeline: s("openPipeline"), joined: s("joined"), offered: s("offered"), benchmark: review.benchmark || 6.19 };
}
function buildActions(portfolios) {
  var actions = [], aid = 0;
  function add(p, theme, issue, ev, impact, rec, owner, prio) { actions.push({ id: "A" + String(++aid).padStart(3, "0"), hrbp: p.display, theme: theme, issue: issue, evidence: ev, impact: impact, recommendation: rec, owner: owner, due: "This month", priority: prio, status: "Not Started" }); }
  portfolios.forEach(function (p) {
    if (p.vacancyPct != null && p.vacancyPct > 20) add(p, "Vacancy", "Vacancy pressure above 20%", "Vacancy " + p.vacancyPct + "% (" + p.vacancy + " of " + p.budget + ")", "Capacity & delivery risk", "Prioritise sourcing; review hold list", "HRBP / TA", "P1");
    var b90 = p.aging.b90 || 0; if (b90 >= 10) add(p, "Ageing", "Roles ageing beyond 90 days", b90 + " roles in 90+ bucket", "TAT breach / escalation", "Escalate 90+ roles; revisit sourcing", "TA", "P1");
    if (p.attrition != null && p.attrition > 5) add(p, "Attrition", "Attrition above 5%", "Attrition " + p.attrition + "%", "Talent loss", "Run retention check-ins", "HRBP", "P1");
    if ((p.pms || {}).goalSetting != null && p.pms.goalSetting < 85) add(p, "PMS", "PMS goal-setting below 85%", "Goal setting " + p.pms.goalSetting + "%", "Cycle readiness", "Drive goal-setting completion", "HRBP", "P2");
    if (p.criticalCases.length) add(p, "Business dependency", "Critical roles flagged", p.criticalCases.slice(0, 3).join("; "), "Key role gaps", "Track top-3 critical roles to closure", "HRBP / Business", "P1");
  });
  return actions;
}
function dataQuality(tracker, budget, portfolios) {
  var n = tracker.records.length;
  var missAge = tracker.records.filter(function (r) { return r.ageing == null; }).length;
  var missCrit = tracker.records.filter(function (r) { return r.criticality === NA; }).length;
  var issues = [
    { type: "Scrambled categoricals (tracker)", count: n, detail: "Approval, Function, Grade, Location, Status, Ageing Bucket, Sourcing anonymised to placeholders — not charted as meaningful.", severity: "high" },
    { type: "Missing numeric ageing", count: missAge, detail: "Tracker rows with no ageing value", severity: "medium" },
    { type: "Missing criticality", count: missCrit, detail: "Criticality/Priority partly scrambled", severity: "medium" },
  ];
  var aliasN = portfolios.filter(function (p) { return p.confidence === "alias"; }).length;
  if (aliasN) issues.push({ type: "Alias-mapped HRBPs", count: aliasN, detail: "Review labels joined to budget portfolios via HRBP_ALIASES (names differ).", severity: "low" });
  return { completeness: n ? Math.round((1 - (missAge + missCrit) / (2 * n)) * 1000) / 10 : 100,
    trackerRows: n, budgetRows: budget.records.length, issues: issues, actionRequired: issues.filter(function (i) { return i.severity === "high"; }).length };
}

/* ============================ ORCHESTRATION ============================ */
function status(msg, ok) { var s = document.getElementById("uploadStatus"); s.innerHTML = msg; s.style.color = ok === false ? "#cc3340" : "#5a6577"; }

function parseAll() {
  status("Loading parser…");
  loadXLSX().then(function () {
    var jobs = [];
    if (files.review) jobs.push(readBook(files.review).then(function (wb) { return { k: "review", wb: wb }; }));
    if (files.budget) jobs.push(readBook(files.budget).then(function (wb) { return { k: "budget", wb: wb }; }));
    if (files.tracker) jobs.push(readBook(files.tracker).then(function (wb) { return { k: "tracker", wb: wb }; }));
    if (!jobs.length) { status("Select at least one workbook first.", false); return; }
    return Promise.all(jobs).then(function (books) {
      var b = {}; books.forEach(function (x) { b[x.k] = x.wb; });
      var MASK = new Masker();
      // require review for the core; fall back if missing
      var review = b.review ? parseReview(b.review, MASK) : reviewFromBaked();
      var bakedPD = {}; baked.portfolios.forEach(function (p) { bakedPD[p.key] = p.display; });
      var budget = b.budget ? parseBudget(b.budget, MASK) : { records: baked.budgetRecords, used: baked.meta.budgetSheetsUsed, ignored: [], portfolioDisplay: bakedPD };
      var tracker = b.tracker ? parseTracker(b.tracker, MASK) : { records: baked.recruitmentRecords, ages: [], used: [], ignored: [] };
      var portfolios = assemble(review, budget);
      var data = {
        meta: Object.assign({}, baked.meta, {
          empty: false,
          generatedAt: new Date().toISOString().slice(0, 10) + " (uploaded)",
          budgetSheetsUsed: budget.used, ignoredSheets: budget.ignored.concat(tracker.ignored),
          hrbpMap: (review._descriptors || []).map(function (m) { return { display: m.display, reviewLabel: m.reviewLabel || NA, budgetSheet: m.budgetSheet, confidence: m.confidence, verify: m.verify }; }),
          benchmark: review.benchmark || 6.19,
        }),
        kpis: rollup(portfolios, review), portfolios: portfolios,
        budgetRecords: budget.records, recruitmentRecords: tracker.records,
        engagement: review.engagement, speakUpMilestones: review.speakUpMilestones,
        initiatives: review.initiatives, actions: buildActions(portfolios), dataQuality: dataQuality(tracker, budget, portfolios),
      };
      // upload-side output guard: ensure no raw names slipped through
      var leaks = guard(data, MASK);
      var warnHtml = "";
      var missing = [];
      if (!b.review) missing.push("Monthly Review (used baked)");
      if (!b.budget) missing.push("Budget (used baked)");
      if (!b.tracker) missing.push("Tracker (used baked)");
      window.__setDashboardData(data);
      document.getElementById("loadChip").className = "status-chip upload";
      document.getElementById("loadChip").textContent = "Uploaded data loaded";
      status("Parsed ✓ — " + portfolios.length + " portfolios, " + budget.records.length + " budget rows, " +
        tracker.records.length + " tracker rows." + (missing.length ? " <b>Note:</b> " + missing.join(", ") + "." : "") +
        (leaks.length ? " <span style='color:#cc3340'>⚠ Masking guard flagged " + leaks.length + " values.</span>" : " Masking guard passed."), leaks.length === 0);
    });
  }).catch(function (err) {
    console.error(err);
    status("Parsing failed: " + err.message + ". Falling back to baked data.", false);
    window.__setDashboardData(baked);
  });
}
function reviewFromBaked() {
  // reconstruct a minimal review object from baked portfolios (when only budget/tracker uploaded)
  var hrbps = {}, names = []; baked.portfolios.forEach(function (p) { if (!p.reviewLabel) return; names.push(p.reviewLabel); hrbps[p.reviewLabel] = { budget: p.budget, active: p.active, joiningsJune: p.joiningsJune, exitsJune: p.exitsJune, joiningsYTD: p.joiningsYTD, exitsYTD: p.exitsYTD, future: p.future, onHold: p.onHold, delimit: p.delimit, attrition: p.attrition, attritionInsight: p.attritionInsight, recruitment: p.recruitment, aging: p.aging, criticalCases: p.criticalCases, pms: p.pms, training: p.training, orgChart: p.orgChart }; });
  return { hrbps: hrbps, hrbpNames: names, engagement: baked.engagement, initiatives: baked.initiatives, benchmark: baked.meta.benchmark, speakUpMilestones: baked.speakUpMilestones };
}
function guard(data, MASK) {
  var leaks = [], names = Object.keys(MASK.e).concat(Object.keys(MASK.c));
  var js = JSON.stringify(data).toLowerCase();
  names.forEach(function (n) { if (n.length >= 4 && n.indexOf("demo") < 0 && n.indexOf("dummy") < 0 && js.indexOf(n) >= 0) leaks.push(n); });
  return leaks;
}

// wire
document.addEventListener("DOMContentLoaded", function () {
  var up = document.getElementById("upReview"), ub = document.getElementById("upBudget"), ut = document.getElementById("upTracker");
  if (up) up.onchange = function () { files.review = this.files[0]; };
  if (ub) ub.onchange = function () { files.budget = this.files[0]; };
  if (ut) ut.onchange = function () { files.tracker = this.files[0]; };
  var pb = document.getElementById("btnParseUpload");
  if (pb) pb.onclick = parseAll;
  var rb = document.getElementById("btnRestoreBaked");
  if (rb) rb.onclick = function () {
    window.__setDashboardData(baked);
    document.getElementById("loadChip").className = "status-chip empty";
    document.getElementById("loadChip").textContent = "No data loaded";
    status("Cleared loaded data.");
  };
});
})();
