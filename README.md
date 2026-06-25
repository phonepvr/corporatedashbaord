# HRBP Workforce & Recruitment Command Centre

A premium, executive-ready, **fully offline** static dashboard for the monthly HRBP review —
budget, hiring, attrition, capability and engagement — built to publish on **GitHub Pages**
and to also open straight from disk (`file://`).

* **Zero network calls at runtime.** Chart.js and SheetJS are vendored locally; every asset
  path is relative.
* **Data is baked in.** The messy Excel parsing happens once in a Python build script that
  emits a clean, anonymised JS global (`window.DASHBOARD_DATA`). The page loads instantly with
  no upload.
* **Privacy by default.** Names, employee codes, candidate names and supervisor references are
  masked **at bake time**, so PII never reaches the shipped `js/data.js`. An output guard fails
  the build if anything PII-shaped leaks.
* **Honest about data limits.** Visuals that the source files can't support are omitted or
  clearly badged *“Illustrative — not in source data”* / *“Degraded by source anonymisation.”*
  Numbers are never invented.

---

## Repository layout

```
/
├── .nojekyll                # GitHub Pages serves every path as-is
├── index.html               # relative asset paths only
├── css/styles.css
├── js/
│   ├── data.js              # BAKED, anonymised data → window.DASHBOARD_DATA = {…}
│   ├── app.js               # all dashboard logic (charts, filters, drawers, search…)
│   └── upload.js            # optional in-browser re-parser (lazy-loads SheetJS)
├── vendor/
│   ├── chart.umd.min.js     # Chart.js v4 (vendored, offline)
│   └── xlsx.full.min.js     # SheetJS (vendored; only used by the optional upload path)
├── build/
│   └── build_data.py        # one-time monthly script: 3 xlsx → js/data.js (with masking)
├── data/                    # (optional) drop the monthly source .xlsx here for rebuilds
└── README.md
```

---

## (a) Rebuilding the data each month

```bash
pip install openpyxl

# Place the three workbooks in the repo root OR in ./data/ :
#   Monthly HRBP Review.xlsx          (PRIMARY source)
#   Budgted numbers Corp and SSC.xlsx (record-level headcount/budget)
#   Recruitment Tracker.xlsx          (degraded — numeric/dates only)

python build/build_data.py            # reads from . or ./data, writes js/data.js
# or:  python build/build_data.py --src ./data
```

The script prints a summary: files read, sheets used vs ignored, row counts, the HRBP mapping
applied (with the **VERIFY** flag), data-quality completeness, and the output-guard result. It
**refuses to write** `js/data.js` if any source name or emp-code-shaped value would leak.

### What each source contributes (source-of-truth hierarchy)

| File | Role | Used for |
|---|---|---|
| **Monthly HRBP Review.xlsx → `Summary`** | **PRIMARY** (a pre-built report) | Executive KPIs, HRBP comparison, funnel, ageing, attrition, PMS, Speak-Up, training, initiatives, critical cases |
| **Budgted numbers…xlsx** (detail sheets) | record-level headcount/budget | Headcount & Budget drill-downs (vacant/occupied by function, location, grade, type) |
| **Recruitment Tracker.xlsx** | heavily degraded | Numeric ageing scatter/histogram + a masked analyst table only |

The three files were anonymised **independently and do not reconcile** — each is presented in its
own right; totals are never force-joined.

---

## (b) HRBP reconciliation — data-driven (no mapping to maintain)

Portfolios are **discovered from the data**, not hard-coded:

* **Budget workbook** — every detail sheet becomes a portfolio, and the **display name is the
  sheet name** itself. Add/rename/remove HRBPs just by changing the sheets.
* **Monthly Review** — the HRBP columns are read from the sheet's own header rows and **joined to
  the budget portfolios by name** (case-insensitive, trimmed).
* **Recruitment Tracker** — categoricals are scrambled, so it is never used as a join key.

In real data the budget sheets and the review columns use the **same** display names, so the join
is **direct** and there is nothing to verify — the selector simply lists whatever portfolios the
workbooks contain.

`HRBP_ALIASES` (top of `build/build_data.py`, mirrored in `js/upload.js`) is an **optional
fallback**, used only when a review label does not directly match a budget sheet name. It ships
with entries for the bundled demo workbooks (whose review uses `Aarav/Meera/…` while the demo
budget uses `Dhruv/Shijumon/…`); for real data with matching names you can leave it empty — the
direct match wins and the aliases are never consulted. `SSC_FOLD` (also optional, default empty)
lets you fold a sheet such as a shared trainee pool into another portfolio instead of letting it
stand alone.

The **Data load & source summary** panel shows the live join for each portfolio with its match
type (`direct` / `alias` / `budget-only`), so you can always see exactly how the workbooks were
reconciled.

---

## (c) Deploying to GitHub Pages

1. Commit and push everything (including `js/data.js`, `vendor/`, and `.nojekyll`).
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**; pick your branch and
   the **`/ (root)`** folder; Save.
3. Open `https://<user>.github.io/<repo>/`. Because every asset path is relative (`./css/…`,
   `./js/…`, `./vendor/…`) it works correctly from the project sub-path, and `.nojekyll` stops
   GitHub from re-processing the files.

The same `index.html` also opens directly from disk (`file://…/index.html`) — the baked data is a
JS global, so there is no `fetch` to be blocked by the `file://` origin.

---

## (d) Privacy guarantee

* Masking happens **at bake time** in `build/build_data.py` (and is mirrored in the optional
  upload path in `js/upload.js`): `Emp. Name → Employee Group N`, `Candidate Name → Candidate A…`,
  supervisor/`Reports to` → `Manager NN`; **employee codes are dropped entirely**.
* After generating `js/data.js`, an **output guard** scans the file and aborts the build if any
  value matches a source name column or looks like a 6–8-digit employee code.
* Aligned to DPDP principles — purpose limitation, data minimisation, access limitation, privacy
  by default.
* **Source workbooks are never committed.** `.gitignore` excludes `*.xlsx` / `*.xls` (and
  `data/*.xlsx`) so HR source files stay local and never reach git history. Place the monthly
  workbooks in the repo root or `./data/`, run the build, and commit only the masked `js/data.js`
  — which is safe to publish.

---

## (e) Two data-load modes

1. **Default (baked):** `js/data.js` renders immediately, offline, no upload. Status chip shows
   *“Demo data loaded (baked).”*
2. **Optional upload override:** in the **Data load & source summary** panel, upload any of the
   three workbooks. SheetJS is **lazy-loaded only then**, an in-browser port of the same
   normalisation + masking runs, and `DASHBOARD_DATA` is replaced (with a local masking-guard
   check). Any workbook you don’t upload falls back to baked data; if parsing fails, the
   dashboard reverts to baked data with a clear notice. Nothing ever leaves your machine.

---

## Notes on data honesty

* The **Recruitment Funnel** and **Ageing buckets** are driven by the Monthly Review, **not** by
  the degraded tracker. The tracker’s scrambled categoricals (status, function, grade, location,
  sourcing, ageing-bucket, approval) are never charted as meaningful — only its numeric `Ageing`,
  dates and row counts are used, behind a data-quality banner. Filters bound to those degraded
  fields are visibly disabled.
* Exit-reason / attrition-by-function / regrettable-exit breakdowns are **not** in the source —
  the qualitative *Insights on Attrition* text is shown instead, badged illustrative.
* The **Portfolio Risk Index** is a workload/risk indicator — *not* an assessment of HRBP
  performance (stated wherever it appears). Weights: Vacancy 25 · Ageing 25 · Attrition 20 ·
  Hiring load 15 · PMS pending 10 · Engagement 5.
* The **Scenario Lens** projections are clearly labelled *Simulated projection.*
