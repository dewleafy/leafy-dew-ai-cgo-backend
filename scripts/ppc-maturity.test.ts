// Dummy values so env validation passes; no real network or database is touched.
for (const [k, v] of Object.entries({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x", APP_BASE_URL: "http://x", ENCRYPTION_KEY: "x", AMAZON_LWA_CLIENT_ID: "x", AMAZON_LWA_CLIENT_SECRET: "x", AMAZON_APP_ID: "x" })) process.env[k] ??= v;
let ECON: any = null; let ROWS: any[] = [];
// Fake PostgREST over fetch: the REAL supabase-js client talks to this, so real query code runs.
(globalThis as any).fetch = async (url: any, init: any = {}) => {
  const u = new URL(String(url)); const table = u.pathname.split("/").pop();
  const accept = String((init.headers && (init.headers["Accept"] || init.headers.accept)) || (init.headers?.get && init.headers.get("accept")) || "");
  const single = accept.includes("vnd.pgrst.object");
  let body: any = [];
  if (table === "amazon_ads_search_term_daily_metrics") body = ROWS;
  else if (table === "amazon_product_economics") body = single ? ECON : (ECON ? [ECON] : []);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
let getAmazonAdsPpcRecommendations: any;

const econ = (status: string) => ({ selling_price: 500, landed_cost: 200, amazon_fee_estimate: 80, shipping_fee_estimate: 40, non_ad_cost: 320, target_profit: 60, max_allowable_ad_spend: 60, target_acos: 20, break_even_acos: 30, profit_status: status, created_at: "2026-09-30" });
// build per-day rows for a term: days = list of day offsets (1..), totals split evenly
function term(name: string, days: number[], t: { imp: number; clk: number; cost: number; sales: number; orders: number }) {
  return days.map((d) => ({ report_date: `2026-09-${String(30 - d).padStart(2, "0")}`, campaign_id: "C1", campaign_name: "Camp", ad_group_id: "G1", ad_group_name: "Grp", search_term: name,
    impressions: t.imp / days.length, clicks: t.clk / days.length, cost: t.cost / days.length, sales: t.sales / days.length, orders: t.orders / days.length }));
}
let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra = "") { (cond ? pass++ : fail++); console.log((cond ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); }
const where = (r: any, term: string) => { for (const k of Object.keys(r)) if (Array.isArray(r[k]) && k !== "heldBackTerms" && r[k].some((i: any) => i.searchTerm === term)) return k; return "(none)"; };

(async () => {
  ({ getAmazonAdsPpcRecommendations } = await import("../src/modules/amazon-ads/amazon-ads-ppc-recommendation.service"));
  // ---------- Scenario 1: live situation — latest economics row is FAIL (as in your 515 cards)
  ECON = econ("FAIL");
  ROWS = [
    ...term("B0C1C84839", [3], { imp: 1, clk: 1, cost: 4, sales: 0, orders: 0 }),                 // the real 1-click example
    ...term("thin two clicks", [2], { imp: 30, clk: 2, cost: 8, sales: 0, orders: 0 }),
    ...term("solid waste term", [1,2,3,4,5,6,7,8,9,10], { imp: 900, clk: 40, cost: 300, sales: 0, orders: 0 }) // mature, many clicks
  ];
  let r = await getAmazonAdsPpcRecommendations({ sellerId: "default", days: 14, targetAcos: 35 });
  console.log("\n[Scenario 1] economics = FAIL");
  check("1-click ASIN term NO LONGER a profit-risk card", where(r, "B0C1C84839") !== "profitRiskWarnings", "now in: " + where(r, "B0C1C84839"));
  const hb = r.heldBackTerms.find((h) => h.searchTerm === "B0C1C84839");
  check("1-click term is listed as held back with reasons", !!hb && hb.originalCategory === "profitRiskWarnings", hb ? hb.reasons.join(" | ") : "missing");
  check("2-click term NOT a profit-risk card", where(r, "thin two clicks") !== "profitRiskWarnings", "now in: " + where(r, "thin two clicks"));
  check("mature 40-click/10-day term still flagged (not over-suppressed)", where(r, "solid waste term") === "profitRiskWarnings", "in: " + where(r, "solid waste term"));
  check("summary reports held-back count", (r.summary.heldBackForImmatureData ?? 0) === 2, String(r.summary.heldBackForImmatureData));

  // ---------- Scenario 2: economics PASS — negatives / bid-down / harvesting rules
  ECON = econ("PASS");
  ROWS = [
    ...term("neg too new", [1,2], { imp: 400, clk: 12, cost: 90, sales: 0, orders: 0 }),                      // 12 clicks but 2 days
    ...term("neg mature", [1,3,5,8,9], { imp: 500, clk: 12, cost: 90, sales: 0, orders: 0 }),                // 12 clicks, 9-day span
    ...term("bid one bad day", [1], { imp: 200, clk: 10, cost: 120, sales: 400, orders: 3 }),                // ACOS 30%
    ...term("bid enough days", [1,2,3,4], { imp: 200, clk: 10, cost: 120, sales: 400, orders: 3 }),
    ...term("harvest new", [1,2,3], { imp: 300, clk: 8, cost: 40, sales: 600, orders: 3 }),                  // good ACOS but only 3-day span
    ...term("harvest mature", [1,3,5,8,9], { imp: 300, clk: 8, cost: 40, sales: 600, orders: 3 })
  ];
  r = await getAmazonAdsPpcRecommendations({ sellerId: "default", days: 14, targetAcos: 35 });
  console.log("\n[Scenario 2] economics = PASS");
  check("negative with 12 clicks but only 2 days -> held to watchlist", where(r, "neg too new") === "watchlistWasteTerms", where(r, "neg too new"));
  check("negative with 12 clicks over 9 days -> allowed", where(r, "neg mature") === "negativeKeywordCandidates", where(r, "neg mature"));
  check("no bid cut from ONE bad day", where(r, "bid one bad day") === "monitorOnlyTerms", where(r, "bid one bad day"));
  check("bid cut allowed with 4 days of data", where(r, "bid enough days") === "bidDownCandidates", where(r, "bid enough days"));
  check("exact-match harvest needs 7-day span (3 days held)", where(r, "harvest new") === "monitorOnlyTerms", where(r, "harvest new"));
  check("exact-match harvest allowed after 9-day span", where(r, "harvest mature") === "exactMatchOpportunities", where(r, "harvest mature"));

  // ---------- Scenario 3: scale only when profit rules PASS
  ECON = econ("RISK");
  r = await getAmazonAdsPpcRecommendations({ sellerId: "default", days: 14, targetAcos: 35 });
  console.log("\n[Scenario 3] economics = RISK (not PASS)");
  check("no scaling (exact match) unless profit rules pass", where(r, "harvest mature") === "monitorOnlyTerms", where(r, "harvest mature"));
  const item = r.monitorOnlyTerms.find((i) => i.searchTerm === "harvest mature");
  check("held-back item carries explanation + dataMaturity", !!item && item.dataMaturity.status === "HELD_BACK" && /profit rules/.test(item.reason), item?.reason.slice(0, 110));
  // ---------- Scenario 4: previously SAVED recommendations re-entering the approval queue
  const { savedRecommendationMaturity } = await import("../src/modules/amazon-ads/ppc-data-maturity");
  console.log("\n[Scenario 4] saved ai_recommendations rows (ledger bridge filter)");
  const saved = (type: string, clicks: number, profitStatus = "PASS") => savedRecommendationMaturity({ recommendationType: type, evidence: { clicks }, profitEvidence: { profitStatus } });
  check("saved PROFIT_RISK row with 1 click is held back", saved("PROFIT_RISK_WARNINGS", 1)?.status === "HELD_BACK");
  check("saved PROFIT_RISK row with 40 clicks passes", saved("PROFIT_RISK_WARNINGS", 40)?.status === "MATURE");
  check("saved scale row (exact match) without profit PASS is held back", saved("EXACT_MATCH_OPPORTUNITIES", 20, "RISK")?.status === "HELD_BACK");
  check("saved watchlist row is never gated", saved("WATCHLIST_WASTE_TERMS", 1)?.status === "MATURE");
  check("unknown recommendation type is left alone (null)", saved("SOMETHING_ELSE", 0) === null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
