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
// DATA-DRIVEN & NAME-FREE (privacy): nothing about the org is hard-coded. Every
// workbook is parsed entirely at run time in the browser. Two real-world wrinkles
// are handled by generic rules (kept in sync with build_data.py):
//   1. Spelling variants of one person merge via a generic PREFIX rule (one name
//      is a case-insensitive prefix of another, shared stem >= 4 chars; the
//      shorter form becomes the display).
//   2. A non-person "pool" sheet (trainee / OJT / SSC / intern) is detected from
//      generic keyword tokens and folded into the largest person portfolio.
var POOL_TOKENS = ["ojt", "ssc", "trainee", "intern", "apprentice", " pool", "get pool"];
var STEM_MIN = 4;
function slug(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "portfolio"; }
function canon(name) { if (name == null) return ""; return String(name).replace(/\s+/g, " ").trim(); }
function isPoolName(name) { var lw = " " + canon(name).toLowerCase() + " "; return POOL_TOKENS.some(function (t) { return lw.indexOf(t) >= 0; }); }
function prefixMatch(a, b) { if (!a || !b) return false; var short = a.length <= b.length ? a : b; return short.length >= STEM_MIN && (a.indexOf(b) === 0 || b.indexOf(a) === 0); }
// Generic name resolver: group prefix-variants, shortest form is canonical.
function buildResolver(names) {
  var forms = {};
  names.forEach(function (n) { var c = canon(n); if (c) { var lw = c.toLowerCase(); if (!(lw in forms)) forms[lw] = c; } });
  var stems = [], canonLower = {};
  Object.keys(forms).sort(function (a, b) { return a.length - b.length; }).forEach(function (lw) {
    var hit = null;
    for (var i = 0; i < stems.length; i++) { if (prefixMatch(stems[i], lw)) { hit = stems[i]; break; } }
    if (hit) canonLower[lw] = hit; else { stems.push(lw); canonLower[lw] = lw; }
  });
  var keyOf = {}, displays = {};
  stems.forEach(function (s) { keyOf[s] = slug(forms[s]); displays[keyOf[s]] = forms[s]; });
  function resolve(name) {
    var c = canon(name).toLowerCase();
    if (!c) return null;
    if (c in canonLower) return keyOf[canonLower[c]];
    for (var i = 0; i < stems.length; i++) { if (prefixMatch(stems[i], c)) return keyOf[stems[i]]; }
    return null;
  }
  return { resolve: resolve, displays: displays };
}

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
  // speakup milestones
  var su = -1; for (var s1 = 0; s1 < rows.length; s1++) { var t1 = norm(cell(s1, 1)).toLowerCase(); if (t1.indexOf("speak") >= 0 && t1.indexOf("up") >= 0) { su = s1; break; } }
  if (su >= 0) {
    var suCols = {}; readHrbpHeader(su + 1).forEach(function (p) { REVIEW_HRBPS.forEach(function (h) { if (p[0].toLowerCase() === h.toLowerCase()) suCols[h] = p[1]; }); });
    for (var mi2 = su + 2; mi2 < su + 12; mi2++) {
      var ml = norm(cell(mi2, 2)); if (!ml) continue;
      var mll = ml.toLowerCase(); if (mll.indexOf("listening") >= 0 || mll.indexOf("speak up+") >= 0 || mll.indexOf("scores") >= 0) break;
      var st = {}; Object.keys(suCols).forEach(function (h) { var v = norm(cell(mi2, suCols[h])); st[h] = v || "Pending"; });
      out.speakUpMilestones.push({ milestone: ml, status: st });
    }
  }
  // Speak-Up / listening scores: anchor on the "Department"/"Survey" header.
  var elh = -1;
  for (var e1 = 0; e1 < rows.length; e1++) { if (norm(cell(e1, 2)).toLowerCase() === "department" && norm(cell(e1, 3)).toLowerCase().indexOf("survey") >= 0) { elh = e1; break; } }
  if (elh >= 0) {
    var curH = NA, seen = false;
    for (var ei = elh + 1; ei < rows.length; ei++) {
      var hc2 = norm(cell(ei, 1)), dept = norm(cell(ei, 2)), score = num(cell(ei, 3));
      if (!hc2 && blank(dept) && score == null) { if (seen) break; else continue; }
      var dl = dept.toLowerCase();
      if (dl.indexOf("top talent") >= 0 || dl.indexOf("readiness") >= 0 || dl.indexOf("hipo") >= 0) break;
      if (hc2) { curH = hc2; seen = true; }
      if (!seen && score != null) { out.benchmark = score; continue; }   // company benchmark
      if (blank(dept) || dept.length > 60) continue;
      out.engagement.push({ hrbp: curH, department: dept, score: score, scoreLabel: score != null ? String(Math.round(score * 100) / 100) : NA });
    }
  }
  return out;
}
function classify(text) {
  var t = text.toLowerCase();
  var cats = [
    ["Compliance", ["compliance", "safety", "ethics", "posh", "audit", "vishwakarma", "loto", "work at height", "transgender", "data hygiene", "data clean"]],
    ["PMS", ["goal setting", "goal settings", "mid-year", "mid year", "end - year", "end-year", "annual review", "kpi", "apr ", "performance", "appraisal", "my commitment", "commitments"]],
    ["Capability", ["hr xcel", "synergy meet", "training", "learning", "knowledge", "workshop", "samvaad", "academy", "mentor", "succeed", "seed", "lead", "leap", "induction"]],
    ["Communication", ["sampark", "time out with hod", "coffee with", "interaction", "town hall", "feedback", "connect", "praise points", "report sharing"]],
    ["Engagement", ["speakup", "speak up", "speak-up", "survey", "recognition", "reward", "r&r", "felicitation", "promotion", "celebration", "festival", "diwali", "ganesh", "navratri", "holi", "christmas", "bday", "birthday", "farewell", "retirement", "sports", "games", "competition", "carrom", "chess", "drawing", "pot lunch", "health", "yoga", "blood donation", "wellbeing", "environment", "plantation", "csr", "voluntary", "new year", "republic day", "independence day", "sankranti", "women's day", "quality month"]]];
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
  // DATA-DRIVEN & NAME-FREE: each detail sheet is a portfolio named after the
  // sheet. Variant-merge + pool-fold happen later (in assemble) via generic rules.
  var records = [], used = [], ignored = [], portfolioDisplay = {}, poolKeys = {};
  wb.SheetNames.forEach(function (sn) {
    var lo = sn.trim().toLowerCase();
    if (lo.indexOf("summary") >= 0) { ignored.push(sn); return; }
    var rows = sheetRows(wb, sn); if (!rows.length) { ignored.push(sn); return; }
    var hi = -1;
    for (var i = 0; i < Math.min(6, rows.length); i++) { var joined = (rows[i] || []).map(function (c) { return norm(c).toLowerCase(); }).join(" "); if (joined.indexOf("position") >= 0 && (joined.indexOf("emp") >= 0 || joined.indexOf("function") >= 0)) { hi = i; break; } }
    if (hi < 0) { ignored.push(sn); return; }       // not a record sheet
    var display = canon(sn.trim()), pf = slug(display), isOjt = lo.indexOf("ojt") >= 0;
    if (!(pf in portfolioDisplay)) portfolioDisplay[pf] = display;
    if (isPoolName(sn)) poolKeys[pf] = true;
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
  return { records: records, used: used, ignored: ignored, portfolioDisplay: portfolioDisplay, poolKeys: poolKeys };
}

/* ============================ TRACKER PARSER (real, record-level) ============================ */
var STATUS_MAP = { "wip": "WIP", "yet to start": "Yet to Start", "tbo": "To Be Offered", "to be offered": "To Be Offered", "offered": "Offered", "joined": "Joined", "confirmation": "Confirmation", "hold": "Hold", "internal movement": "Internal Movement" };
function titleCase(s) { return String(s).trim().replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }); }
function normStatus(v) { if (blank(v)) return "Unknown"; var k = String(v).replace(/\s+/g, " ").trim().toLowerCase(); return STATUS_MAP[k] || titleCase(v); }
function normCrit(v) { if (blank(v)) return NA; var k = String(v).trim().toLowerCase(); if (["1", "high", "p1", "critical"].indexOf(k) >= 0) return "High"; if (["2", "medium", "med", "p2"].indexOf(k) >= 0) return "Medium"; if (["3", "low", "p3"].indexOf(k) >= 0) return "Low"; if (["na", "n/a", "#n/a", "`", "-"].indexOf(k) >= 0) return NA; return titleCase(v); }
function normPType(v) { if (blank(v)) return NA; var k = String(v).trim().toLowerCase(); if (k === "new") return "New"; if (k.indexOf("replac") >= 0) return "Replacement"; if (k.indexOf("carry") >= 0) return "Carry Forwarded"; if (k.indexOf("adhoc") >= 0 || k.indexOf("ad hoc") >= 0) return "Adhoc"; return titleCase(v); }
function attributeHrbp(raw, keys, resolve) { if (blank(raw)) return null; var first = canon(String(raw).split(/\s+/)[0]); var k = (resolve && resolve(first)) || slug(first); return keys.indexOf(k) >= 0 ? k : null; }
function parseTracker(wb, MASK, portfolioKeys, resolve) {
  portfolioKeys = portfolioKeys || [];
  var sn = findSheet(wb, ["Recruitment Tracker ", "Recruitment Tracker"]);
  var ignored = wb.SheetNames.filter(function (s) { return s !== sn; });
  var rows = sn ? sheetRows(wb, sn) : [];
  var hdr = rows[0] || [], idx = {}; hdr.forEach(function (h, i) { idx[norm(h).toLowerCase()] = i; });
  function col() { var hints = Array.prototype.slice.call(arguments);
    for (var a = 0; a < hints.length; a++) if (idx[hints[a]] != null) return idx[hints[a]];
    for (var b = 0; b < hints.length; b++) { var best = null, bl = 1e9; for (var k in idx) if (k.indexOf(hints[b]) === 0 && k.length < bl) { bl = k.length; best = idx[k]; } if (best != null) return best; }
    for (var c = 0; c < hints.length; c++) for (var k2 in idx) if (k2.indexOf(hints[c]) >= 0) return idx[k2];
    return null;
  }
  var iBhr = col("fpr from", "bhr"), iAppr = col("approval"), iYear = col("budgeted year"), iType = col("replacement/ new", "replacement"),
    iPos = idx["position"], iGrade = col("grade"), iFunc = col("function"), iSub = col("sub function"), iLoc = col("location"),
    iSrc = col("sourcing through"), iTat = col("agreed tat for offer", "agreed tat"), iAge = idx["ageing"], iBucket = col("ageing bucket"),
    iStatus = col("current status"), iCrit = col("criticality / priority", "criticality"), iCand = col("candidate name"),
    iAct = col("hiring activation"), iJd = col("jd finalisation"), iCommit = col("commitment date"), iJoin = col("candidate joining");
  function dIso(v) { if (v instanceof Date) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0"); return null; }
  var records = [], ages = [], unattr = 0, bktMismatch = 0;
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r] || []; if (!row.some(function (c) { return !blank(c); })) continue;
    function g(i) { return i != null ? row[i] : null; }
    var age = num(g(iAge)); if (age != null) ages.push(age);
    var tat = num(g(iTat)); tat = (tat != null && tat > 0) ? tat : null;
    // Bucket is derived from the numeric Ageing (days) when present; the tracker's
    // own text "Ageing Bucket" label is only a fallback when days are blank.
    var srcBkt = norm(g(iBucket)), bkt;
    if (age != null) { bkt = bucket(age); if (srcBkt && normBucketLabel(srcBkt) !== bkt) bktMismatch++; }
    else { bkt = normBucketLabel(srcBkt) || NA; }
    var pf = attributeHrbp(g(iBhr), portfolioKeys, resolve); if (pf == null) unattr++;
    records.push({ roleId: "Role " + String(r).padStart(4, "0"), portfolio: pf,
      position: norm(g(iPos)) || NA, "function": norm(g(iFunc)) || NA, subFunction: norm(g(iSub)) || NA,
      location: norm(g(iLoc)) || NA, grade: norm(g(iGrade)) || NA, positionType: normPType(g(iType)),
      budgetedYear: norm(g(iYear)) || NA, approval: norm(g(iAppr)) || NA, sourcing: norm(g(iSrc)) || NA,
      status: normStatus(g(iStatus)), criticality: normCrit(g(iCrit)),
      ageing: age != null ? Math.round(age) : null, ageingBucket: bkt || NA,
      agreedTat: tat != null ? Math.round(tat) : null, tatBreach: (age != null && tat != null && age > tat),
      activationDate: dIso(g(iAct)), jdDate: dIso(g(iJd)), commitmentDate: dIso(g(iCommit)), joiningDate: dIso(g(iJoin)),
      candidate: MASK.cand(g(iCand)) });
  }
  return { records: records, ages: ages, used: sn ? [sn] : [], ignored: ignored, unattributed: unattr, bucketMismatch: bktMismatch };
}
// Mutually-exclusive buckets — labels share no endpoints, so a role lands in exactly one.
function bucket(a) { if (a == null) return NA; a = +a; return a <= 30 ? "0-30" : a <= 60 ? "31-60" : a <= 90 ? "61-90" : a <= 120 ? "91-120" : "121+"; }
var SRC_BUCKET_MAP = { "0-30": "0-30", "30-60": "31-60", "60-90": "61-90", "90-120": "91-120", "120+": "121+" };
function normBucketLabel(s) { s = (s || "").trim(); return SRC_BUCKET_MAP[s] || s; }

/* ============================ RECONCILE + ASSEMBLE ============================ */
function reconcile(review, portfolioDisplay, resolve) {
  var nameToKey = {}; Object.keys(portfolioDisplay).forEach(function (k) { nameToKey[canon(portfolioDisplay[k]).toLowerCase()] = k; nameToKey[k] = k; });
  var descriptors = {};
  (review.hrbpNames || []).forEach(function (L) {
    var k = null;
    if (resolve) { var rk = resolve(L); if (rk in portfolioDisplay) k = rk; }
    if (k == null) k = nameToKey[canon(L).toLowerCase()] || nameToKey[slug(L)];
    var conf;
    if (k == null) { k = slug(L); portfolioDisplay[k] = portfolioDisplay[k] || L; conf = "review-only"; }
    else { conf = (canon(L).toLowerCase() === canon(portfolioDisplay[k] || "").toLowerCase()) ? "direct" : "alias"; }
    descriptors[k] = { key: k, display: portfolioDisplay[k] || L, reviewLabel: L, budgetSheet: portfolioDisplay[k] || NA, confidence: conf, verify: false };
  });
  Object.keys(portfolioDisplay).forEach(function (k) {
    if (!descriptors[k]) descriptors[k] = { key: k, display: portfolioDisplay[k], reviewLabel: null, budgetSheet: portfolioDisplay[k], confidence: "budget-only", verify: false };
  });
  return descriptors;
}
function trackerSummary(recs) {
  var closed = ["Joined", "Confirmation", "Internal Movement"];
  var ageing = ["WIP", "To Be Offered"];
  var openr = recs.filter(function (r) { return closed.indexOf(r.status) < 0; });
  var ager = recs.filter(function (r) { return ageing.indexOf(r.status) >= 0; });
  function c(pred) { return recs.filter(pred).length; }
  function o(pred) { return openr.filter(pred).length; }
  function ag(pred) { return ager.filter(pred).length; }
  // Ageing / TAT counts are scoped to WIP + To Be Offered only; criticality stays open-scoped.
  return { total: recs.length, open: openr.length,
    wip: c(function (r) { return r.status === "WIP"; }), offered: c(function (r) { return r.status === "Offered"; }),
    joined: c(function (r) { return r.status === "Joined"; }), hold: c(function (r) { return r.status === "Hold"; }),
    ageing: ager.length,
    ageing90plus: ag(function (r) { return r.ageingBucket === "91-120" || r.ageingBucket === "121+"; }),
    tatBreach: ag(function (r) { return r.tatBreach; }), highCrit: o(function (r) { return r.criticality === "High"; }) };
}
function assemble(review, budget, tracker, resolve) {
  var byPf = {}; budget.records.forEach(function (r) { (byPf[r.portfolio] = byPf[r.portfolio] || []).push(r); });
  var trkByPf = {}; ((tracker && tracker.records) || []).forEach(function (r) { if (r.portfolio) (trkByPf[r.portfolio] = trkByPf[r.portfolio] || []).push(r); });
  var descriptors = reconcile(review, budget.portfolioDisplay, resolve);
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
      tracker: trackerSummary(trkByPf[pkey] || []),
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
    attrition: attr, openPipeline: s("openPipeline"), joined: s("joined"), offered: s("offered"), benchmark: review.benchmark || 8.2 };
}
function buildActions(portfolios) {
  var actions = [], aid = 0;
  function add(p, theme, issue, ev, impact, rec, owner, prio) { actions.push({ id: "A" + String(++aid).padStart(3, "0"), hrbp: p.display, theme: theme, issue: issue, evidence: ev, impact: impact, recommendation: rec, owner: owner, due: "This month", priority: prio, status: "Not Started" }); }
  portfolios.forEach(function (p) {
    var t = p.tracker || {};
    if (p.vacancyPct != null && p.vacancyPct > 20) add(p, "Vacancy", "Vacancy pressure above 20%", "Vacancy " + p.vacancyPct + "% (" + p.vacancy + " of " + p.budget + ")", "Capacity & delivery risk", "Prioritise sourcing; review hold list", "HRBP / TA", "P1");
    var b90 = (p.aging.b90 || 0) || t.ageing90plus || 0; if (b90 >= 10) add(p, "Ageing", "Roles ageing beyond 90 days", b90 + " roles 90+ days", "TAT breach / escalation", "Escalate 90+ roles; revisit sourcing", "TA", "P1");
    if (p.attrition != null && p.attrition > 5) add(p, "Attrition", "Attrition above 5%", "Attrition " + p.attrition + "%", "Talent loss", "Run retention check-ins", "HRBP", "P1");
    if ((p.pms || {}).goalSetting != null && p.pms.goalSetting < 85) add(p, "PMS", "PMS goal-setting below 85%", "Goal setting " + p.pms.goalSetting + "%", "Cycle readiness", "Drive goal-setting completion", "HRBP", "P2");
    if (p.criticalCases.length) add(p, "Business dependency", "Critical roles flagged", p.criticalCases.slice(0, 3).join("; "), "Key role gaps", "Track top-3 critical roles to closure", "HRBP / Business", "P1");
    if (t.tatBreach) add(p, "TAT", "Roles open beyond agreed TAT", t.tatBreach + " roles past agreed TAT", "Hiring SLA breach", "Escalate TAT-breached roles to TA / business", "TA", "P1");
    if (t.highCrit) add(p, "Criticality", "High-criticality roles open", t.highCrit + " high-criticality roles in pipeline", "Business-critical gaps", "Prioritise high-criticality roles this month", "HRBP / TA", "P1");
  });
  return actions;
}
function dataQuality(tracker, budget, portfolios, unattributed, bucketMismatch) {
  var R = tracker.records, n = R.length;
  var AGEING = ["WIP", "To Be Offered"];
  var ageScope = R.filter(function (r) { return AGEING.indexOf(r.status) >= 0; });
  function c(pred) { return R.filter(pred).length; }
  function ca(pred) { return ageScope.filter(pred).length; }
  var missAge = ca(function (r) { return r.ageing == null; });
  var missBkt = ca(function (r) { return r.ageingBucket === NA; });
  var missCrit = c(function (r) { return r.criticality === NA; });
  var missStatus = c(function (r) { return r.status === "Unknown"; });
  var nonAppr = c(function (r) { return (r.approval || "").toLowerCase().indexOf("non") >= 0; });
  var missTat = c(function (r) { return r.agreedTat == null; });
  var joinedNoDate = c(function (r) { return r.status === "Joined" && !r.joiningDate; });
  var issues = [
    { type: "Missing ageing (tracker)", count: missAge, detail: "WIP / To-Be-Offered roles with no numeric ageing — ageing-day metrics exclude these.", severity: "medium" },
    { type: "Missing ageing bucket", count: missBkt, detail: "WIP / To-Be-Offered rows with no ageing bucket.", severity: "low" },
    { type: "Missing criticality", count: missCrit, detail: "Roles with no Criticality/Priority set.", severity: "medium" },
    { type: "Unknown status", count: missStatus, detail: "Rows whose Current Status is blank/unmapped.", severity: "medium" },
    { type: "Non-approved roles", count: nonAppr, detail: "Roles flagged Non-Approved still in the pipeline.", severity: "low" },
    { type: "Joined without joining date", count: joinedNoDate, detail: "Status = Joined but no joining date.", severity: "low" },
    { type: "Missing agreed TAT", count: missTat, detail: "Rows with no/invalid agreed TAT — TAT-breach excludes these.", severity: "low" },
  ];
  if (unattributed) issues.push({ type: "Unattributed tracker rows", count: unattributed, detail: "Rows whose 'FPR from TA/BHR' did not match a portfolio (shown under All only).", severity: "medium" });
  if (bucketMismatch) issues.push({ type: "Ageing bucket vs days mismatch", count: bucketMismatch, detail: "Rows where the tracker's text 'Ageing Bucket' disagrees with the numeric 'Ageing' days — the dashboard uses the days-derived bucket.", severity: "low" });
  return { completeness: n ? Math.round((1 - (missAge + missCrit + missStatus) / (3 * n)) * 1000) / 10 : 100,
    trackerRows: n, budgetRows: budget.records.length, unattributed: unattributed || 0, issues: issues,
    actionRequired: issues.filter(function (i) { return i.severity === "high" || i.severity === "medium"; }).length };
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
      var budget = b.budget ? parseBudget(b.budget, MASK) : { records: baked.budgetRecords, used: baked.meta.budgetSheetsUsed, ignored: [], portfolioDisplay: bakedPD, poolKeys: {} };

      // --- NAME-FREE canonicalisation: merge spelling variants + fold pool sheets ---
      var poolKeys = budget.poolKeys || {};
      var personKeys = Object.keys(budget.portfolioDisplay).filter(function (k) { return !poolKeys[k]; });
      var resolverNames = personKeys.map(function (k) { return budget.portfolioDisplay[k]; }).concat(review.hrbpNames || []);
      var R = buildResolver(resolverNames), resolve = R.resolve, resDisp = R.displays;
      var remap = {}, canonDisplay = {};
      personKeys.forEach(function (k) {
        var disp = budget.portfolioDisplay[k], nk = resolve(disp) || k;
        remap[k] = nk; canonDisplay[nk] = resDisp[nk] || disp;
      });
      // pool sheets fold into the largest person portfolio (by budget record count)
      var recCount = {}; budget.records.forEach(function (r) { recCount[r.portfolio] = (recCount[r.portfolio] || 0) + 1; });
      function foldedCount(nk) { return Object.keys(recCount).reduce(function (a, k) { return a + (remap[k] === nk ? recCount[k] : 0); }, 0); }
      var ranked = Object.keys(canonDisplay).sort(function (a, b) { return foldedCount(b) - foldedCount(a); });
      var foldTarget = ranked[0] || null;
      Object.keys(poolKeys).forEach(function (k) { remap[k] = foldTarget; });
      budget.records.forEach(function (r) { if (remap[r.portfolio]) r.portfolio = remap[r.portfolio]; });
      budget.portfolioDisplay = canonDisplay;

      var pkeys = Object.keys(budget.portfolioDisplay);
      var tracker = b.tracker ? parseTracker(b.tracker, MASK, pkeys, resolve) : { records: baked.recruitmentRecords, ages: [], used: [], ignored: [], unattributed: 0 };
      var portfolios = assemble(review, budget, tracker, resolve);
      var data = {
        meta: Object.assign({}, baked.meta, {
          empty: false,
          generatedAt: new Date().toISOString().slice(0, 10) + " (uploaded)",
          budgetSheetsUsed: budget.used, ignoredSheets: budget.ignored.concat(tracker.ignored),
          hrbpMap: (review._descriptors || []).map(function (m) { return { display: m.display, reviewLabel: m.reviewLabel || NA, budgetSheet: m.budgetSheet, confidence: m.confidence, verify: m.verify }; }),
          benchmark: review.benchmark || 8.2,
        }),
        kpis: rollup(portfolios, review), portfolios: portfolios,
        budgetRecords: budget.records, recruitmentRecords: tracker.records,
        engagement: review.engagement, speakUpMilestones: review.speakUpMilestones,
        initiatives: review.initiatives, actions: buildActions(portfolios), dataQuality: dataQuality(tracker, budget, portfolios, tracker.unattributed, tracker.bucketMismatch),
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
      // Auto-collapse the data-load panel so navigation stays clean after loading.
      var dl = document.getElementById("dataLoad");
      if (dl) { dl.classList.remove("open"); var ch = dl.querySelector(".c-head"); if (ch) ch.setAttribute("aria-expanded", "false"); }
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
var GUARD_SAFE = ["hold", "joined", "offered", "other", "lead", "leap", "seed", "succeed", "new", "none", "review", "pending", "confirmation", "internal", "movement", "medium", "approved", "shift", "sales", "legal", "audit", "stores", "gift"];
function guard(data, MASK) {
  var leaks = [], names = Object.keys(MASK.e).concat(Object.keys(MASK.c));
  var js = JSON.stringify(data).toLowerCase();
  names.forEach(function (n) {
    n = String(n).replace(/\s+/g, " ").trim();
    if (n.length < 5 || n.indexOf("demo") >= 0 || n.indexOf("dummy") >= 0 || GUARD_SAFE.indexOf(n) >= 0) return;
    var re = new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    if (re.test(js)) leaks.push(n);
  });
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
