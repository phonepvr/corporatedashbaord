#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py — HRBP Workforce & Recruitment Command Centre
================================================================================
One-time, monthly build script. Reads the three sanitised HR workbooks, parses
them section-by-section (they are human-formatted reports, NOT clean tables),
applies the HRBP reconciliation mapping, masks all PII at bake time, computes
KPIs + a data-quality report, and emits  js/data.js  as:

        window.DASHBOARD_DATA = { ... };

The dashboard then loads that JS global directly — so it works on GitHub Pages
(https, sub-path) AND when index.html is opened from disk (file://), with zero
network calls at runtime.

USAGE
-----
    pip install openpyxl
    python build/build_data.py            # reads xlsx from repo root or ./data
    python build/build_data.py --src .    # explicit source dir

PRIVACY
-------
Names / employee codes / candidate names / supervisor refs are masked to stable,
non-reversible pseudonyms (Employee Group N, Candidate A, Manager NN). After
generation the emitted data.js is scanned and the build FAILS LOUDLY if any
PII-shaped string (a source name or a 6–8 digit emp-code) leaks. Safe to publish.
================================================================================
"""

import argparse
import datetime as _dt
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("ERROR: openpyxl is required.  Run:  pip install openpyxl")

# ------------------------------------------------------------------------------
# 0. CONFIG
# ------------------------------------------------------------------------------
FILE_REVIEW = "Monthly HRBP Review.xlsx"
FILE_BUDGET = "Budgted numbers Corp and SSC.xlsx"
FILE_TRACKER = "Recruitment Tracker.xlsx"

DEFAULT_TAT_DAYS = 45          # tracker's TAT field is scrambled -> assumed default
NOT_AVAILABLE = "Not Available"

# ------------------------------------------------------------------------------
# HRBP_DISPLAY_MAP  — the ONE editable reconciliation constant (see README).
#
# The three workbooks label HRBPs differently and DO NOT share a join key:
#   * Monthly Review 'Summary'  -> Aarav, Meera, Nisha, Riya, Kabir
#   * Budget workbook           -> Dhruv, Shijumon, Khyati, Chanchal, Lincia (+ SSC OJT)
#   * Recruitment Tracker       -> scrambled placeholders (UNUSABLE as a key)
#
# We map each source's labels onto 5 canonical portfolios with the display names
# Dhruv, Chanchal, Lincia, Khyati, Shiju  (+ an "All HRBPs" rollup).
#
# Heuristic = SIZE-RANKED.  # VERIFY — positional/size assumption:
#   Shijumon <-> Kabir  -> "Shiju"   (~57-58 budgeted; near-exact size; HIGH confidence)
#   Dhruv    <-> Aarav  -> "Dhruv"   (both the largest portfolio;        HIGH confidence)
#   Khyati/Chanchal/Lincia <-> Riya/Nisha/Meera  -> mapped by DESCENDING size; UNVERIFIED.
# Correct a single entry below if the true mapping is known.
# ------------------------------------------------------------------------------
HRBP_DISPLAY_MAP = {
    # canonical portfolio key : { display, reviewLabel, budgetSheet, confidence }
    "dhruv":   {"display": "Dhruv",   "reviewLabel": "Aarav", "budgetSheet": "Dhruv",     "confidence": "high",       "verify": False},
    "khyati":  {"display": "Khyati",  "reviewLabel": "Riya",  "budgetSheet": "Khyati",    "confidence": "unverified", "verify": True},
    "chanchal":{"display": "Chanchal","reviewLabel": "Nisha", "budgetSheet": "Chanchal",  "confidence": "unverified", "verify": True},
    "lincia":  {"display": "Lincia",  "reviewLabel": "Meera", "budgetSheet": "Lincia",    "confidence": "unverified", "verify": True},
    "shiju":   {"display": "Shiju",   "reviewLabel": "Kabir", "budgetSheet": "Shijumon",  "confidence": "high",       "verify": False},
}
# SSC OJT (trainee pool) is handled by Aarav per the review ("Aarav for SSC"),
# and Aarav <-> Dhruv, so the SSC OJT budget sheet is folded into the Dhruv portfolio.
SSC_OJT_PORTFOLIO = "dhruv"

PORTFOLIO_ORDER = ["dhruv", "chanchal", "lincia", "khyati", "shiju"]

# Sheets to detect-but-ignore for record parsing (pivots / scratch / empty).
IGNORE_SHEET_HINTS = [
    "sheet1", "sheet2", "sheet3", "sheet4", "sheet5", "sheet6", "sheet7",
    "function wise", "birthday celebration", "hrbp wise summary",
    "overall summary", "finance", "recruitment tracker finance",
]

WARNINGS = []
def warn(msg):
    WARNINGS.append(msg)
    print("  [warn]", msg)


# ------------------------------------------------------------------------------
# small helpers
# ------------------------------------------------------------------------------
def norm(s):
    """Trim + collapse whitespace/newlines of a header/label."""
    if s is None:
        return ""
    return re.sub(r"\s+", " ", str(s).replace("\n", " ")).strip()

def is_blank(v):
    if v is None:
        return True
    s = str(v).strip()
    return s == "" or s in ("-", "NA", "N/A", "na", "n/a", "#REF!")

def num(v, default=None):
    """Best-effort numeric extraction (handles '251.62 days', '6.19', 0.026...)."""
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d+(?:\.\d+)?", str(v).replace(",", ""))
    return float(m.group()) if m else default

def pct(frac):
    """0.026 -> 2.6 ; passthrough if already a percentage-ish number."""
    if frac is None:
        return None
    f = float(frac)
    return round(f * 100, 1) if f <= 1.0 else round(f, 1)

def find_sheet(wb, *hints):
    """Case-insensitive, trimmed, contains-based sheet matcher."""
    lc = {name: name.strip().lower() for name in wb.sheetnames}
    for h in hints:
        h = h.strip().lower()
        for name, low in lc.items():
            if low == h:
                return name
    for h in hints:
        h = h.strip().lower()
        for name, low in lc.items():
            if h in low or low in h:
                return name
    return None


# ==============================================================================
# 1. PRIVACY / MASKING LAYER  (applied at bake time AND mirrored in upload.js)
# ==============================================================================
class Masker:
    """Stable, non-reversible pseudonymisation. Same source value -> same label
    within a build, but labels carry no real-world meaning."""
    def __init__(self):
        self._emp = {}
        self._cand = {}
        self._mgr = {}

    def employee(self, raw):                       # Emp. Name -> "Employee Group N"
        if is_blank(raw):
            return None
        key = str(raw).strip().lower()
        if key not in self._emp:
            self._emp[key] = "Employee Group %d" % (len(self._emp) + 1)
        return self._emp[key]

    def candidate(self, raw):                      # Candidate Name -> "Candidate A.."
        if is_blank(raw):
            return None
        key = str(raw).strip().lower()
        if key not in self._cand:
            n = len(self._cand)
            # A..Z, then AA, AB ...
            label = ""
            x = n
            while True:
                label = chr(ord("A") + x % 26) + label
                x = x // 26 - 1
                if x < 0:
                    break
            self._cand[key] = "Candidate %s" % label
        return self._cand[key]

    def manager(self, raw):                        # Reports to / Supervisor -> "Manager NN"
        if is_blank(raw):
            return None
        key = str(raw).strip().lower()
        if key not in self._mgr:
            self._mgr[key] = "Manager %02d" % (len(self._mgr) + 1)
        return self._mgr[key]

    def role(self, idx):                            # masked record id for tracker rows
        return "Role %04d" % idx

    def source_name_values(self):
        """All raw name strings seen — used by the output guard."""
        out = set()
        for d in (self._emp, self._cand, self._mgr):
            out.update(d.keys())
        return out

MASK = Masker()


# ==============================================================================
# 2. MONTHLY REVIEW  ('Summary' sheet) — the PRIMARY source.
#    Parsed SECTION BY SECTION using the label in col B/C as the anchor.
# ==============================================================================
REVIEW_HRBPS = ["Aarav", "Meera", "Nisha", "Riya", "Kabir"]

def parse_review(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sn = find_sheet(wb, "Summary")
    ws = wb[sn]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    wb.close()

    def cell(r, c):
        if 0 <= r < len(rows) and 0 <= c < len(rows[r]):
            return rows[r][c]
        return None

    # locate a section header (text in col B, index 1) -> returns its row index
    def section_row(label):
        for i, r in enumerate(rows):
            if norm(cell(i, 1)).lower() == label.lower():
                return i
        return None

    def label_in_row(i):
        # section row-labels live in col C (index 2)
        return norm(cell(i, 2))

    out = {"hrbps": {}, "engagement": [], "initiatives": [], "benchmark": None}
    for h in REVIEW_HRBPS:
        out["hrbps"][h] = {}

    # ---- Headcount Overview --------------------------------------------------
    # value columns: Aarav=3, Meera=4, Nisha=5, Riya=6, Kabir=7, Total=8
    hc_cols = {"Aarav": 3, "Meera": 4, "Nisha": 5, "Riya": 6, "Kabir": 7}
    hc_start = section_row("Headcount Overview")
    hc_fields = {
        "Total Position 2026": "budget",
        "Active Employees": "active",
        "Joining's in June": "joiningsJune",
        "Exits in June": "exitsJune",
        "Joining's YTD": "joiningsYTD",
        "Exits YTD": "exitsYTD",
        "Current Positions": "wipCurrent",
        "Future Positions": "future",
        "On Hold": "onHold",
        "Delimit/Redundant": "delimit",
        "Attrition %": "attrition",
        "Insights on Attrition": "attritionInsight",
    }
    if hc_start is not None:
        for i in range(hc_start + 1, hc_start + 16):
            lbl = label_in_row(i)
            if not lbl:
                continue
            for key, field in hc_fields.items():
                if key.lower() in lbl.lower():
                    for h, c in hc_cols.items():
                        v = cell(i, c)
                        if field == "attrition":
                            out["hrbps"][h][field] = pct(num(v))
                        elif field == "attritionInsight":
                            out["hrbps"][h][field] = (norm(v) if not is_blank(v)
                                                      else NOT_AVAILABLE)
                        else:
                            out["hrbps"][h][field] = (int(num(v)) if num(v) is not None
                                                      else None)
                    break

    # ---- Recruitment Overview (RPO / Consultant / Other per HRBP) ------------
    # header row has each HRBP spanning 3 sub-cols. We locate the HRBP header row
    # then read its 3 columns. Stages map onto the funnel.
    rec_start = section_row("Recruitment Overview")
    # EXACT-label map (anchored on col C). Note "Offered" is a substring of
    # "To Be Offered", so we match on normalised equality, NOT contains.
    rec_field = {"wip": "wip", "offered": "offered", "to be offered": "toBeOffered",
                 "joined 2026": "joined", "offer declined": "offerDeclined"}
    # sub-column layout (0-indexed): Aarav 3-5, Meera 6-8, Nisha 9-11, Riya 12-14, Kabir 15-17
    rec_cols = {"Aarav": 3, "Meera": 6, "Nisha": 9, "Riya": 12, "Kabir": 15}
    if rec_start is not None:
        for h in REVIEW_HRBPS:
            out["hrbps"][h]["recruitment"] = {}
        for i in range(rec_start + 1, rec_start + 9):
            lbl = label_in_row(i).lower().strip()
            field = rec_field.get(lbl)
            if field is None:
                continue
            for h, c0 in rec_cols.items():
                rpo = num(cell(i, c0)) or 0
                cons = num(cell(i, c0 + 1)) or 0
                other = num(cell(i, c0 + 2)) or 0
                out["hrbps"][h]["recruitment"][field] = {
                    "rpo": int(rpo), "consultant": int(cons), "other": int(other),
                    "total": int(rpo + cons + other),
                }

    # ---- Aging Overview ------------------------------------------------------
    ag_start = section_row("Aging Overview")
    ag_cols = {"Aarav": 3, "Meera": 4, "Nisha": 5, "Riya": 6, "Kabir": 7}
    ag_rows = {"WIP": "wip", "0-30": "b0_30", "30-60": "b30_60",
               "60-90": "b60_90", "90 +": "b90"}
    if ag_start is not None:
        for h in REVIEW_HRBPS:
            out["hrbps"][h]["aging"] = {}
        for i in range(ag_start + 1, ag_start + 9):
            lbl = label_in_row(i)
            if not lbl:
                continue
            if lbl.lower().startswith("critical"):
                for h, c in ag_cols.items():
                    txt = cell(i, c)
                    out["hrbps"][h]["criticalCases"] = (norm(txt).split("  ")
                                                        if not is_blank(txt) else [])
                    if not is_blank(txt):
                        # split numbered list "1. .. 2. .. 3. .."
                        parts = re.split(r"\s*\d+\.\s*", str(txt))
                        out["hrbps"][h]["criticalCases"] = [norm(p) for p in parts if norm(p)]
                continue
            for ak, field in ag_rows.items():
                if ak.lower() == lbl.lower() or ak.replace(" ", "") == lbl.replace(" ", ""):
                    for h, c in ag_cols.items():
                        out["hrbps"][h]["aging"][field] = int(num(cell(i, c)) or 0)
                    break

    # ---- HR Initiatives Calendar (ragged grid) ------------------------------
    init_start = section_row("HR Initiatives Calendar")
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"]
    if init_start is not None:
        # header months sit at init_start+1, cols 3..14
        end = section_row("Training & Development") or (init_start + 40)
        current_hrbp = None
        for i in range(init_start + 2, end):
            row_label = norm(cell(i, 2))
            if row_label:
                # detect an HRBP block label (may be "Aarav", "Aarav for SSC", "Nisha"..)
                matched = None
                for h in REVIEW_HRBPS:
                    if h.lower() in row_label.lower():
                        matched = h
                        break
                if matched:
                    current_hrbp = matched
                # if not a known HRBP, the label is itself an event chip (col C event)
            for mi, m in enumerate(months):
                v = cell(i, 3 + mi)
                if not is_blank(v):
                    txt = norm(v)
                    if txt and not txt.lower().startswith("dummy business note"):
                        out["initiatives"].append({
                            "hrbp": current_hrbp or NOT_AVAILABLE,
                            "month": m, "event": txt,
                            "category": classify_event(txt),
                        })

    # ---- Training & Development ----------------------------------------------
    tr_start = section_row("Training & Development")
    if tr_start is not None:
        # header at tr_start+1; rows tr_start+2 .. until 'Org Charts'
        end = section_row("Org Charts") or (tr_start + 10)
        # labels in col C are scrambled; map positionally by Total Headcount magnitude,
        # but we attach training to HRBPs by order of appearance fallback.
        order = ["Aarav", "Nisha", "Meera", "Riya", "Kabir"]  # observed row order after the SSC note rows
        # We instead capture every data row that has a numeric Total Headcount.
        train_rows = []
        for i in range(tr_start + 2, end):
            total = num(cell(i, 3))
            label = norm(cell(i, 2))
            if total is None:
                continue
            days = num(cell(i, 9))
            train_rows.append({
                "rowLabel": label, "totalHeadcount": int(total),
                "trainingDays": round(days, 2) if days is not None else None,
                "upcoming": norm(cell(i, 10)) or NOT_AVAILABLE,
            })
        # Attach by matching the HRBP name embedded in the row label where possible.
        for h in REVIEW_HRBPS:
            for tr in train_rows:
                if h.lower() in tr["rowLabel"].lower():
                    out["hrbps"][h]["training"] = tr
                    break
        # Aarav's row label is the scrambled "Dummy business note" first data row.
        if "training" not in out["hrbps"]["Aarav"] and train_rows:
            out["hrbps"]["Aarav"]["training"] = train_rows[0]

    # ---- Org Charts ----------------------------------------------------------
    oc_start = section_row("Org Charts")
    if oc_start is not None:
        for i in range(oc_start + 1, oc_start + 8):
            lbl = norm(cell(i, 2))
            for h in REVIEW_HRBPS:
                if lbl.lower() == h.lower():
                    out["hrbps"][h]["orgChart"] = norm(cell(i, 3)) or NOT_AVAILABLE

    # ---- PMS -----------------------------------------------------------------
    pms_start = section_row("PMS")
    if pms_start is not None:
        for i in range(pms_start + 1, pms_start + 8):
            lbl = norm(cell(i, 2))
            for h in REVIEW_HRBPS:
                if lbl.lower() == h.lower():
                    out["hrbps"][h]["pms"] = {
                        "goalSetting": pct(num(cell(i, 3))),
                        "midYear": norm(cell(i, 4)) or NOT_AVAILABLE,
                        "endYear": norm(cell(i, 5)) or NOT_AVAILABLE,
                    }

    # ---- Speak-Up ------------------------------------------------------------
    su_start = None
    for i, r in enumerate(rows):
        if "speak" in norm(cell(i, 1)).lower() and "up" in norm(cell(i, 1)).lower():
            su_start = i
            break
    if su_start is not None:
        # header row su_start+1: cols 3..7 -> Aarav, Nisha, Meera, Riya, Kabir (ORDER differs!)
        hdr = [norm(cell(su_start + 1, c)) for c in range(3, 8)]
        su_cols = {}
        for idx, name in enumerate(hdr):
            for h in REVIEW_HRBPS:
                if name.lower() == h.lower():
                    su_cols[h] = 3 + idx
        milestones = []
        for i in range(su_start + 2, su_start + 12):
            lbl = norm(cell(i, 2))
            if not lbl:
                continue
            if "employee listening" in lbl.lower():
                break
            ms = {"milestone": lbl, "status": {}}
            for h, c in su_cols.items():
                st = norm(cell(i, c))
                ms["status"][h] = st if st else "Pending"
            milestones.append(ms)
        out["speakUpMilestones"] = milestones

    # ---- Employee Listening Scores ------------------------------------------
    el_start = None
    for i, r in enumerate(rows):
        if "employee listening scores" in norm(cell(i, 1)).lower() or \
           "employee listening scores" in norm(cell(i, 2)).lower():
            el_start = i
            break
    if el_start is not None:
        current_hrbp = NOT_AVAILABLE
        for i in range(el_start + 1, len(rows)):
            hrbp_cell = norm(cell(i, 1))
            dept = norm(cell(i, 2))
            score_raw = cell(i, 3)
            if hrbp_cell and hrbp_cell.lower() == "hrbp":
                continue
            if hrbp_cell and hrbp_cell.lower() != "hrbp":
                current_hrbp = hrbp_cell
            if dept.lower() == "demo steel india":
                out["benchmark"] = num(score_raw)
                continue
            # skip leaked free-text rows (no score or NA-with-longtext)
            if is_blank(dept) or len(dept) > 60:
                continue
            score = num(score_raw)
            out["engagement"].append({
                "hrbp": current_hrbp if current_hrbp != "HRBP" else NOT_AVAILABLE,
                "department": dept,
                "score": score,
                "scoreLabel": (str(round(score, 2)) if score is not None else NOT_AVAILABLE),
            })

    return out


EVENT_CATEGORIES = [
    ("compliance", ["compliance", "safety", "ethics", "posh", "audit", "governance"]),
    ("pms", ["goal", "performance", "appraisal", "review", "commitment"]),
    ("capability", ["learning", "awareness", "training", "workshop", "capability", "synergy", "leadership"]),
    ("communication", ["connect", "feedback", "communication", "interaction", "town", "quarterly"]),
    ("engagement", ["engagement", "recognition", "reward", "festival", "celebration",
                    "wellbeing", "health", "games", "lunch", "donation", "felicitation", "farewell"]),
]
def classify_event(text):
    t = text.lower()
    for cat, kws in EVENT_CATEGORIES:
        if any(k in t for k in kws):
            return cat.capitalize()
    return "Culture"


# ==============================================================================
# 3. BUDGET WORKBOOK — record-level headcount/budget (detail sheets).
# ==============================================================================
# header synonym map -> canonical field
BUDGET_SYNONYMS = {
    "function plant": "plant",
    "function 1": "function",
    "department": "department",
    "sub department": "subDepartment",
    "position lvl": "positionLevel",
    "position id": "positionId",
    "position name": "positionName",
    "emp. code": "_empCode",      # PII -> dropped
    "emp. name": "_empName",      # PII -> masked
    "employee grade": "grade",
    "employee level": "grade",
    "regular / trainee": "employeeType",
    "regular/trainee": "employeeType",
    "vacant/occupied": "occupancy",
    "occupied/vacant": "occupancy",
    "remarks": "remarks",
    "sub department": "subDepartment",
}

def map_header(h):
    key = norm(h).lower()
    if key in BUDGET_SYNONYMS:
        return BUDGET_SYNONYMS[key]
    # contains-based fallbacks
    if "sub" in key and "department" in key:
        return "subDepartment"
    if "grade" in key or "level" in key:
        return "grade"
    if "vacant" in key or "occupied" in key:
        return "occupancy"
    if "regular" in key or "trainee" in key:
        return "employeeType"
    if key.startswith("function") and "1" in key:
        return "function"
    if "plant" in key:
        return "plant"
    if "position name" in key:
        return "positionName"
    if "position lvl" in key or key == "position level":
        return "positionLevel"
    if "emp" in key and "code" in key:
        return "_empCode"
    if "emp" in key and "name" in key:
        return "_empName"
    return None

def clean_occupancy(val, emp_name):
    """Normalise occupancy; infer from emp presence when the column is absent."""
    if not is_blank(val):
        v = str(val).strip().lower()
        if "occup" in v:
            return "Occupied"
        if "vacant" in v:
            return "Vacant"
    # fallback inference
    return "Occupied" if not is_blank(emp_name) else "Vacant"

def norm_emp_type(val):
    if is_blank(val):
        return "Regular"
    v = str(val).strip().lower()
    if "trainee" in v or "ojt" in v or "get" in v or "mt" in v:
        if "ojt" in v:
            return "OJT"
        return "Trainee"
    if "contract" in v or "bpo" in v:
        return "Contractual"
    return "Regular"

def parse_budget(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    records = []
    used, ignored = [], []
    # which sheets are detail sheets (per HRBP) vs summary/ignored
    sheet_to_portfolio = {}
    for pkey, m in HRBP_DISPLAY_MAP.items():
        sheet_to_portfolio[m["budgetSheet"].strip().lower()] = pkey

    for sn in wb.sheetnames:
        low = sn.strip().lower()
        portfolio = None
        if low in sheet_to_portfolio:
            portfolio = sheet_to_portfolio[low]
        elif "ssc ojt" in low or low == "ssc ojt":
            portfolio = SSC_OJT_PORTFOLIO
        # skip summary sheets / unknowns
        if portfolio is None or "summary" in low:
            ignored.append(sn)
            continue

        ws = wb[sn]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        if not rows:
            ignored.append(sn)
            continue
        # find header row = first row containing 'position id' / 'position name'
        hdr_idx = None
        for i, r in enumerate(rows[:6]):
            joined = " ".join(norm(c).lower() for c in r if c is not None)
            if "position" in joined and ("emp" in joined or "function" in joined):
                hdr_idx = i
                break
        if hdr_idx is None:
            hdr_idx = 0
        header = rows[hdr_idx]
        colmap = {}
        for ci, h in enumerate(header):
            field = map_header(h)
            if field and field not in colmap:
                colmap[field] = ci

        n_before = len(records)
        for r in rows[hdr_idx + 1:]:
            if not any(not is_blank(c) for c in r):
                continue
            def g(field):
                ci = colmap.get(field)
                return r[ci] if ci is not None and ci < len(r) else None
            pos_name = g("positionName")
            pos_id = g("positionId")
            if is_blank(pos_name) and is_blank(pos_id):
                continue
            emp_name = g("_empName")
            occ = clean_occupancy(g("occupancy"), emp_name)
            rec = {
                "portfolio": portfolio,
                "plant": norm(g("plant")) or NOT_AVAILABLE,
                "function": norm(g("function")) or NOT_AVAILABLE,
                "department": norm(g("department")) or NOT_AVAILABLE,
                "subDepartment": norm(g("subDepartment")) or NOT_AVAILABLE,
                "positionLevel": norm(g("positionLevel")) or NOT_AVAILABLE,
                "positionName": norm(pos_name) or NOT_AVAILABLE,
                "grade": norm(g("grade")) or NOT_AVAILABLE,
                "employeeType": norm_emp_type(g("employeeType")) if not (low == "ssc ojt") else "OJT",
                "occupancy": occ,
                # PII masked:  emp code DROPPED entirely; emp name -> stable pseudonym
                "holder": MASK.employee(emp_name) if occ == "Occupied" else None,
                "remarks": norm(g("remarks")) or "",
            }
            records.append(rec)
        used.append(sn)
        if len(records) - n_before == 0:
            warn("budget sheet %r yielded 0 records" % sn)
    wb.close()
    return records, used, ignored


# ==============================================================================
# 4. RECRUITMENT TRACKER — heavily degraded. Keep only trustworthy fields.
# ==============================================================================
def parse_tracker(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sn = find_sheet(wb, "Recruitment Tracker ", "Recruitment Tracker")
    used = [sn] if sn else []
    ignored = [s for s in wb.sheetnames if s != sn]
    records = []
    ageing_values = []
    if sn:
        ws = wb[sn]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        header = rows[0] if rows else []
        idx = {norm(h).lower(): i for i, h in enumerate(header)}
        def col(name_hint, default=None):
            for k, i in idx.items():
                if name_hint in k:
                    return i
            return default
        i_sno = col("s_no", 0)
        i_ageing = col("ageing", None)
        # 'ageing bucket' also contains 'ageing'; pick the exact numeric 'ageing'
        for k, i in idx.items():
            if k == "ageing":
                i_ageing = i
        i_poscode = col("position code")
        i_cand = col("candidate name")
        i_act = col("hiring activation")
        i_jd = col("jd finalisation")
        i_commit = col("commitment date")
        i_join = col("candidate joining")
        i_repl = col("replacement")
        i_crit = col("criticality")

        def date_iso(v):
            if isinstance(v, (_dt.datetime, _dt.date)):
                return v.strftime("%Y-%m-%d")
            return None

        for ri, r in enumerate(rows[1:], start=1):
            if not any(not is_blank(c) for c in r):
                continue
            def g(i):
                return r[i] if i is not None and i < len(r) else None
            ageing = num(g(i_ageing))
            if ageing is not None:
                ageing_values.append(ageing)
            # 'Replacement/New' partially real ("New" survives)
            repl_raw = norm(g(i_repl))
            repl = "New" if repl_raw.lower() == "new" else ("Replacement" if "replac" in repl_raw.lower() else NOT_AVAILABLE)
            crit_raw = norm(g(i_crit))
            crit = crit_raw if crit_raw in ("1", "2", "3") else NOT_AVAILABLE
            records.append({
                "roleId": MASK.role(ri),
                "ageing": int(ageing) if ageing is not None else None,
                "ageingBucket": ageing_bucket(ageing),
                "tatBreach": (ageing is not None and ageing > DEFAULT_TAT_DAYS),
                "positionType": repl,
                "criticality": crit,
                "activationDate": date_iso(g(i_act)),
                "jdDate": date_iso(g(i_jd)),
                "commitmentDate": date_iso(g(i_commit)),
                "joiningDate": date_iso(g(i_join)),
                # masked candidate; emp code / name never emitted raw
                "candidate": MASK.candidate(g(i_cand)),
                # degraded categoricals are explicitly NOT emitted as if meaningful
                "degraded": True,
            })
    wb.close()
    return records, ageing_values, used, ignored

def ageing_bucket(a):
    if a is None:
        return NOT_AVAILABLE
    a = float(a)
    if a <= 30:  return "0-30"
    if a <= 60:  return "30-60"
    if a <= 90:  return "60-90"
    if a <= 120: return "90-120"
    return "120+"


# ==============================================================================
# 5. ASSEMBLE per-portfolio summary + KPIs
# ==============================================================================
def assemble(review, budget_records):
    portfolios = []
    # budget-record rollups per portfolio
    by_pf = {}
    for r in budget_records:
        by_pf.setdefault(r["portfolio"], []).append(r)

    for pkey in PORTFOLIO_ORDER:
        m = HRBP_DISPLAY_MAP[pkey]
        rl = m["reviewLabel"]
        rv = review["hrbps"].get(rl, {})
        recs = by_pf.get(pkey, [])

        budget = rv.get("budget")
        active = rv.get("active")
        vacancy = (budget - active) if (budget is not None and active is not None) else None
        vacancyPct = round(vacancy / budget * 100, 1) if (vacancy is not None and budget) else None

        rec = rv.get("recruitment", {})
        def rsum(stage):
            d = rec.get(stage)
            return d["total"] if d else 0
        open_pipeline = rsum("wip") + rsum("toBeOffered") + rsum("offered")
        offered = rsum("offered")
        joined = rsum("joined")
        offer_to_join = round(joined / offered * 100, 1) if offered else None
        total_funnel = open_pipeline + joined + rsum("offerDeclined")
        closure = round(joined / total_funnel * 100, 1) if total_funnel else None

        aging = rv.get("aging", {})
        wip = aging.get("wip", 0)
        b90 = aging.get("b90", 0)
        tat_breach_pct = round(b90 / wip * 100, 1) if wip else None

        pms = rv.get("pms", {})
        goal = pms.get("goalSetting")
        pms_pending = round(100 - goal, 1) if goal is not None else None

        attrition = rv.get("attrition")

        # engagement: lowest dept score vs benchmark
        eng = [e for e in review["engagement"] if e["hrbp"].lower() == rl.lower() and e["score"] is not None]
        lowest = min(eng, key=lambda e: e["score"]) if eng else None

        portfolios.append({
            "key": pkey,
            "display": m["display"],
            "reviewLabel": rl,
            "budgetSheet": m["budgetSheet"],
            "confidence": m["confidence"],
            "verify": m["verify"],
            # headcount
            "budget": budget, "active": active,
            "vacancy": vacancy, "vacancyPct": vacancyPct,
            "joiningsJune": rv.get("joiningsJune"), "exitsJune": rv.get("exitsJune"),
            "joiningsYTD": rv.get("joiningsYTD"), "exitsYTD": rv.get("exitsYTD"),
            "netMovementYTD": ((rv.get("joiningsYTD") or 0) - (rv.get("exitsYTD") or 0)),
            "future": rv.get("future"), "onHold": rv.get("onHold"),
            "delimit": rv.get("delimit"),
            "attrition": attrition,
            "attritionInsight": rv.get("attritionInsight", NOT_AVAILABLE),
            # recruitment funnel
            "recruitment": rec,
            "openPipeline": open_pipeline, "offered": offered, "joined": joined,
            "offerToJoin": offer_to_join, "closureRate": closure,
            # ageing
            "aging": aging, "tatBreachPct": tat_breach_pct,
            "criticalCases": rv.get("criticalCases", []),
            # pms
            "pms": pms, "pmsPending": pms_pending,
            # training / org / engagement
            "training": rv.get("training"),
            "orgChart": rv.get("orgChart", NOT_AVAILABLE),
            "engagementLowest": (lowest["department"] if lowest else NOT_AVAILABLE),
            "engagementLowestScore": (lowest["score"] if lowest else None),
            # budget-record rollups
            "budgetRecordCount": len(recs),
            "occupiedRecords": sum(1 for r in recs if r["occupancy"] == "Occupied"),
            "vacantRecords": sum(1 for r in recs if r["occupancy"] == "Vacant"),
        })

    # Portfolio Risk Index (workload/risk indicator — NOT performance).
    # weights: Vacancy 25 · Ageing 25 · Attrition 20 · Hiring load 15 · PMS pending 10 · Engagement 5
    def safe(v, d=0): return v if v is not None else d
    max_vac = max([safe(p["vacancyPct"]) for p in portfolios] + [1])
    max_age = max([safe(p["aging"].get("b90")) for p in portfolios] + [1])
    max_attr = max([safe(p["attrition"]) for p in portfolios] + [1])
    max_load = max([safe(p["openPipeline"]) for p in portfolios] + [1])
    max_pms = max([safe(p["pmsPending"]) for p in portfolios] + [1])
    bench = review.get("benchmark") or 6.19
    for p in portfolios:
        eng_gap = max(0, bench - safe(p["engagementLowestScore"], bench))
        idx = (
            25 * safe(p["vacancyPct"]) / max_vac +
            25 * safe(p["aging"].get("b90")) / max_age +
            20 * safe(p["attrition"]) / max_attr +
            15 * safe(p["openPipeline"]) / max_load +
            10 * safe(p["pmsPending"]) / max_pms +
            5 * (eng_gap / max(bench, 1))
        )
        p["riskIndex"] = round(idx, 1)
        p["riskBand"] = ("High" if idx >= 60 else "Moderate" if idx >= 35 else "Low")
    return portfolios


# ==============================================================================
# 6. KPI roll-up (All HRBPs) + actions + data quality
# ==============================================================================
def rollup_kpis(portfolios, review):
    def s(field):
        return sum((p[field] or 0) for p in portfolios if p.get(field) is not None)
    budget = s("budget"); active = s("active")
    vacancy = budget - active
    joinYTD = s("joiningsYTD"); exitYTD = s("exitsYTD")
    openpipe = s("openPipeline")
    # weighted-average attrition (by active)
    tot_active = sum((p["active"] or 0) for p in portfolios) or 1
    attr = round(sum((p["attrition"] or 0) * (p["active"] or 0) for p in portfolios) / tot_active, 1)
    return {
        "budget": budget, "active": active,
        "vacancy": vacancy,
        "vacancyPct": round(vacancy / budget * 100, 1) if budget else None,
        "joiningsYTD": joinYTD, "exitsYTD": exitYTD,
        "netMovementYTD": joinYTD - exitYTD,
        "attrition": attr,
        "openPipeline": openpipe,
        "joined": s("joined"), "offered": s("offered"),
        "benchmark": review.get("benchmark") or 6.19,
    }

def build_actions(portfolios):
    """Derive 'This Month's Priorities' from the signals."""
    actions = []
    aid = 0
    def add(pf, theme, issue, evidence, impact, rec, owner, priority):
        nonlocal aid
        aid += 1
        actions.append({
            "id": "A%03d" % aid, "hrbp": pf["display"], "theme": theme,
            "issue": issue, "evidence": evidence, "impact": impact,
            "recommendation": rec, "owner": owner, "due": "This month",
            "priority": priority, "status": "Not Started",
        })
    for p in portfolios:
        if p["vacancyPct"] is not None and p["vacancyPct"] > 20:
            add(p, "Vacancy", "Vacancy pressure above 20%%",
                "Vacancy %.1f%% (%s of %s positions)" % (p["vacancyPct"], p["vacancy"], p["budget"]),
                "Capacity & delivery risk", "Prioritise sourcing for open roles; review hold list", "HRBP / TA", "P1")
        b90 = p["aging"].get("b90", 0)
        if b90 and b90 >= 10:
            add(p, "Ageing", "Roles ageing beyond 90 days",
                "%d roles in 90+ bucket" % b90, "TAT breach / business escalation",
                "Escalate 90+ roles; revisit sourcing channel", "TA", "P1")
        if p["attrition"] is not None and p["attrition"] > 5:
            add(p, "Attrition", "Attrition above 5%%",
                "Attrition %.1f%%" % p["attrition"], "Talent loss",
                "Run retention check-ins; act on exit themes", "HRBP", "P1")
        goal = (p["pms"] or {}).get("goalSetting")
        if goal is not None and goal < 85:
            add(p, "PMS", "PMS goal-setting below 85%%",
                "Goal setting %.1f%%" % goal, "Performance cycle readiness",
                "Drive goal-setting completion", "HRBP", "P2")
        if p["criticalCases"]:
            add(p, "Business dependency", "Critical roles flagged",
                "; ".join(p["criticalCases"][:3]), "Key role gaps",
                "Track top-3 critical roles to closure", "HRBP / Business", "P1")
    return actions

def data_quality(tracker_records, budget_records, portfolios, ageing_values):
    issues = []
    def add(kind, count, detail, severity):
        issues.append({"type": kind, "count": count, "detail": detail, "severity": severity})

    n_tr = len(tracker_records)
    miss_ageing = sum(1 for r in tracker_records if r["ageing"] is None)
    miss_commit = sum(1 for r in tracker_records if not r["commitmentDate"])
    miss_join = sum(1 for r in tracker_records if not r["joiningDate"])
    miss_crit = sum(1 for r in tracker_records if r["criticality"] == NOT_AVAILABLE)
    add("Scrambled categoricals (tracker)", n_tr,
        "Approval, Function, Sub-Function, Grade, Location, Current Status, Ageing Bucket, "
        "Sourcing were anonymised to placeholders — NOT charted as meaningful.", "high")
    add("Missing numeric ageing", miss_ageing, "Tracker rows with no ageing value", "medium")
    add("Missing commitment date", miss_commit, "Tracker rows without a commitment date", "low")
    add("Joined without joining date", 0, "Status taxonomy degraded in tracker — derived from review instead", "low")
    add("Missing criticality", miss_crit, "Criticality/Priority partly scrambled", "medium")

    # budget side
    miss_grade = sum(1 for r in budget_records if r["grade"] == NOT_AVAILABLE)
    add("Missing grade (budget)", miss_grade, "Budget rows without a usable grade", "low")
    # duplicate position ids in tracker (position code numeric)
    add("Verify-flagged HRBP mapping",
        sum(1 for p in portfolios if p["verify"]),
        "Khyati/Chanchal/Lincia ↔ Riya/Nisha/Meera mapped by size; correct HRBP_DISPLAY_MAP if known.",
        "medium")

    total_fields = n_tr if n_tr else 1
    completeness = round(100 * (1 - (miss_ageing + miss_crit) / (2 * total_fields)), 1) if n_tr else 100.0
    return {
        "completeness": completeness,
        "trackerRows": n_tr,
        "budgetRows": len(budget_records),
        "ageingMin": min(ageing_values) if ageing_values else None,
        "ageingMax": max(ageing_values) if ageing_values else None,
        "issues": issues,
        "actionRequired": sum(1 for i in issues if i["severity"] == "high"),
    }


# ==============================================================================
# 7. OUTPUT GUARD — fail loudly if PII leaks into data.js
# ==============================================================================
def output_guard(js_text, source_names):
    problems = []
    low = js_text.lower()
    for name in source_names:
        nm = name.strip().lower()
        if len(nm) >= 4 and nm in low and "demo" not in nm and "dummy" not in nm:
            problems.append("source name leaked: %r" % name)
    # emp-code-shaped 6-8 digit runs inside quoted values
    for m in re.finditer(r'"[^"]*\b(\d{6,8})\b[^"]*"', js_text):
        ctx = m.group(0)
        # position ids / codes intentionally dropped; flag any stray
        problems.append("possible emp-code-shaped value: %s" % ctx[:60])
    return problems


# ==============================================================================
# MAIN
# ==============================================================================
def resolve(src, fname):
    for cand in (os.path.join(src, fname), os.path.join(src, "data", fname)):
        if os.path.exists(cand):
            return cand
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=".", help="folder containing the 3 xlsx (or its ./data)")
    ap.add_argument("--out", default=os.path.join("js", "data.js"))
    args = ap.parse_args()

    print("=" * 78)
    print("HRBP Command Centre — data build")
    print("=" * 78)

    p_review = resolve(args.src, FILE_REVIEW)
    p_budget = resolve(args.src, FILE_BUDGET)
    p_tracker = resolve(args.src, FILE_TRACKER)
    for label, p in [("Monthly Review", p_review), ("Budget", p_budget), ("Tracker", p_tracker)]:
        if not p:
            sys.exit("ERROR: could not find %s workbook near %r" % (label, args.src))
        print("  read:", p)

    print("\n[1/5] Parsing Monthly Review (PRIMARY)...")
    review = parse_review(p_review)
    print("      HRBPs:", list(review["hrbps"].keys()),
          "| engagement depts:", len(review["engagement"]),
          "| initiatives:", len(review["initiatives"]))

    print("[2/5] Parsing Budget workbook (record-level)...")
    budget_records, b_used, b_ignored = parse_budget(p_budget)
    print("      detail sheets used:", b_used)
    print("      records:", len(budget_records))

    print("[3/5] Parsing Recruitment Tracker (degraded)...")
    tracker_records, ageing_values, t_used, t_ignored = parse_tracker(p_tracker)
    print("      tracker rows:", len(tracker_records),
          "| numeric ageing present:", len(ageing_values))

    print("[4/5] Assembling portfolios + KPIs...")
    portfolios = assemble(review, budget_records)
    kpis = rollup_kpis(portfolios, review)
    actions = build_actions(portfolios)
    dq = data_quality(tracker_records, budget_records, portfolios, ageing_values)

    hrbp_map_view = []
    for pkey in PORTFOLIO_ORDER:
        m = HRBP_DISPLAY_MAP[pkey]
        hrbp_map_view.append({
            "display": m["display"], "reviewLabel": m["reviewLabel"],
            "budgetSheet": m["budgetSheet"], "confidence": m["confidence"],
            "verify": m["verify"],
        })

    data = {
        "meta": {
            "title": "HRBP Workforce & Recruitment Command Centre",
            "subtitle": "Monthly Review | Budget • Hiring • Attrition • Capability • Engagement",
            "generatedAt": _dt.date.today().isoformat(),
            "tatAssumptionDays": DEFAULT_TAT_DAYS,
            "benchmark": kpis["benchmark"],
            "hrbpMap": hrbp_map_view,
            "sources": {
                "review": FILE_REVIEW, "budget": FILE_BUDGET, "tracker": FILE_TRACKER,
            },
            "budgetSheetsUsed": b_used,
            "ignoredSheets": sorted(set(b_ignored + t_ignored)),
            "warnings": WARNINGS,
            "privacyNote": "All names, employee codes, candidate names and supervisor "
                           "references are masked at bake time. No PII is shipped.",
        },
        "kpis": kpis,
        "portfolios": portfolios,
        "budgetRecords": budget_records,
        "recruitmentRecords": tracker_records,
        "engagement": review["engagement"],
        "speakUpMilestones": review.get("speakUpMilestones", []),
        "initiatives": review["initiatives"],
        "actions": actions,
        "dataQuality": dq,
    }

    print("[5/5] Emitting %s + running output guard..." % args.out)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    header = ("// generated %s — do not edit by hand\n"
              "// HRBP Workforce & Recruitment Command Centre — baked, anonymised data.\n"
              % _dt.date.today().isoformat())
    js_text = header + "window.DASHBOARD_DATA = " + payload + ";\n"

    problems = output_guard(payload, MASK.source_name_values())
    if problems:
        print("\nOUTPUT GUARD FAILED — PII leak suspected:")
        for pr in problems[:20]:
            print("   -", pr)
        sys.exit("Build aborted: refusing to emit data.js with possible PII.")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(js_text)

    # ---- console summary ----
    print("\n" + "-" * 78)
    print("BUILD SUMMARY")
    print("-" * 78)
    print("  Files read : %s, %s, %s" % (FILE_REVIEW, FILE_BUDGET, FILE_TRACKER))
    print("  Budget detail sheets used :", ", ".join(b_used))
    print("  Ignored / pivot sheets    :", ", ".join(sorted(set(b_ignored + t_ignored))))
    print("  Budget records   :", len(budget_records))
    print("  Tracker records  :", len(tracker_records), "(degraded — numeric/date only)")
    print("  Engagement depts :", len(review["engagement"]))
    print("  Initiatives      :", len(review["initiatives"]))
    print("  Derived actions  :", len(actions))
    print("  HRBP mapping applied (canonical <- review / budget):")
    for v in hrbp_map_view:
        flag = "  ⚠ VERIFY" if v["verify"] else ""
        print("     %-9s <- review:%-6s budget:%-9s [%s]%s"
              % (v["display"], v["reviewLabel"], v["budgetSheet"], v["confidence"], flag))
    print("  Data-quality completeness :", dq["completeness"], "%")
    if WARNINGS:
        print("  Warnings:")
        for w in WARNINGS:
            print("     -", w)
    print("  Output guard : PASSED (no PII leaked)")
    print("  Wrote        :", args.out, "(%d KB)" % (len(js_text) // 1024))
    print("-" * 78)
    print("Done.")

if __name__ == "__main__":
    main()
