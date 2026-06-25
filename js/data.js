// No data is shipped by default. Upload your workbooks (or run build/build_data.py)
// to populate the dashboard. This empty skeleton keeps the page working offline
// with a "no data" state until real, masked data is loaded.
window.DASHBOARD_DATA = {
  meta: {
    title: "HRBP Workforce & Recruitment Command Centre",
    subtitle: "Monthly Review | Budget • Hiring • Attrition • Capability • Engagement",
    generatedAt: "—",
    tatAssumptionDays: 45,
    benchmark: 6.19,
    hrbpMap: [],
    sources: {},
    budgetSheetsUsed: [],
    ignoredSheets: [],
    warnings: [],
    privacyNote: "All names, employee codes, candidate names and supervisor references are masked at load time. No PII is shipped.",
    empty: true
  },
  kpis: {
    budget: 0, active: 0, vacancy: 0, vacancyPct: null,
    joiningsYTD: 0, exitsYTD: 0, netMovementYTD: 0,
    attrition: null, openPipeline: 0, joined: 0, offered: 0, benchmark: 6.19
  },
  portfolios: [],
  budgetRecords: [],
  recruitmentRecords: [],
  engagement: [],
  speakUpMilestones: [],
  initiatives: [],
  actions: [],
  dataQuality: { completeness: 0, trackerRows: 0, budgetRows: 0, issues: [], actionRequired: 0 }
};
