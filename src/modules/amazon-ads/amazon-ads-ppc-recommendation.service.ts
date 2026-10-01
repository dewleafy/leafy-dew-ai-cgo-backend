import { logger } from "../../utils/logger";
import { supabase } from "../../db/supabase";
import { ProductEconomicsRow, ProductProfitStatus } from "../product-economics/product-economics.types";
import { logSafeAmazonAdsSupabaseError } from "./amazon-ads-client.service";
import { evaluatePpcDataMaturity, inclusiveSpanDays, PpcDataMaturity } from "./ppc-data-maturity";

export type RecommendationCategory =
  | "exactMatchOpportunities"
  | "productTargetingOpportunities"
  | "watchlistWasteTerms"
  | "negativeKeywordCandidates"
  | "negativeProductTargetCandidates"
  | "bidDownCandidates"
  | "productPageCheckWarnings"
  | "profitRiskWarnings"
  | "monitorOnlyTerms";

export type RecommendationAction =
  | "ADD_EXACT_KEYWORD_AFTER_APPROVAL"
  | "ADD_PRODUCT_TARGET_AFTER_APPROVAL"
  | "ADD_NEGATIVE_AFTER_APPROVAL"
  | "MONITOR_DO_NOT_NEGATIVE_YET"
  | "CHECK_LISTING_BEFORE_NEGATIVE"
  | "LOWER_BID_AFTER_APPROVAL"
  | "DO_NOT_SCALE_FIX_PRICE_COST_OR_BUNDLE"
  | "MONITOR";

type SearchTermMetricRow = {
  report_date: string | null;
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  search_term: string;
  impressions: number | string | null;
  clicks: number | string | null;
  cost: number | string | null;
  sales: number | string | null;
  orders: number | string | null;
};

type MetricAccumulator = {
  /** Distinct report days (YYYY-MM-DD) on which this term had data. */
  dates: Set<string>;
  searchTerm: string;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
};

type Evidence = {
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  ctr: number;
  cpc: number;
  acos: number | null;
  roas: number;
  conversionRate: number;
};

type ProfitEvidence = {
  profitDataStatus: "AVAILABLE" | "MISSING" | "MISSING_COST_DATA";
  targetProfit: number | null;
  maxAllowableAdSpend: number | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  profitStatus: ProductProfitStatus | null;
  /** Which product's economics these numbers came from (the ad group's top-spend advertised ASIN). */
  economicsAsin?: string | null;
  /** Every ASIN this ad group advertises (an ad group can advertise several). */
  mappedAsins?: string[];
  /** AD_GROUP_ASIN = matched by ASIN; NO_ECONOMICS_ROW = ASIN known but no cost row; UNMAPPED = ad group not linked to any ASIN yet. */
  economicsSource?: "AD_GROUP_ASIN" | "NO_ECONOMICS_ROW" | "UNMAPPED";
};

export type RecommendationItem = {
  searchTerm: string;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  recommendationType: string;
  recommendedAction: RecommendationAction;
  priorityScore: number;
  priorityLabel: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  confidenceScore: number;
  confidenceLabel: "LOW" | "MEDIUM" | "HIGH";
  approvalTier: "TIER_1" | "TIER_2";
  requiresApproval: true;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  reason: string;
  evidence: Evidence;
  profitEvidence: ProfitEvidence;
  ruleVersion: "profit_ppc_v1";
  strategyVersion: "ai_cgo_v2_2_shadow_mode";
  /** Blueprint §12 data-maturity check result for this recommendation. */
  dataMaturity: PpcDataMaturity;
};

export type HeldBackTerm = {
  searchTerm: string;
  campaignId: string;
  adGroupId: string;
  originalCategory: RecommendationCategory;
  originalAction: RecommendationAction;
  reasons: string[];
  blueprintRule: string | null;
};

export type PpcRecommendationResponse = {
  ok: true;
  sellerId: string;
  days: number;
  targetAcos: number;
  effectiveTargetAcos: number;
  effectiveMode: "READ_ONLY_SHADOW_MODE";
  summary: Record<string, number>;
  profitDataStatus: "AVAILABLE" | "MISSING" | "MISSING_COST_DATA";
  exactMatchOpportunities: RecommendationItem[];
  productTargetingOpportunities: RecommendationItem[];
  watchlistWasteTerms: RecommendationItem[];
  negativeKeywordCandidates: RecommendationItem[];
  negativeProductTargetCandidates: RecommendationItem[];
  bidDownCandidates: RecommendationItem[];
  productPageCheckWarnings: RecommendationItem[];
  profitRiskWarnings: RecommendationItem[];
  monitorOnlyTerms: RecommendationItem[];
  /** Suggestions that were NOT turned into actions because the data was too thin (first 200). */
  heldBackTerms: HeldBackTerm[];
  warnings: string[];
  savedCount?: number;
  skippedDuplicateCount?: number;
};

const SAVEABLE_RECOMMENDATION_CATEGORIES: RecommendationCategory[] = [
  "exactMatchOpportunities",
  "productTargetingOpportunities",
  "watchlistWasteTerms",
  "negativeKeywordCandidates",
  "negativeProductTargetCandidates",
  "bidDownCandidates",
  "productPageCheckWarnings",
  "profitRiskWarnings"
];

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function getAmazonAdsPpcRecommendationDateRange(days: number): { startDate: string; endDate: string } {
  return {
    startDate: getDateDaysAgo(days),
    endDate: getDateDaysAgo(1)
  };
}

function isAsinLikeSearchTerm(searchTerm: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(searchTerm.trim());
}

function createEvidence(accumulator: MetricAccumulator): Evidence {
  const acos = accumulator.sales > 0 ? (accumulator.cost / accumulator.sales) * 100 : null;

  return {
    impressions: roundTwo(accumulator.impressions),
    clicks: roundTwo(accumulator.clicks),
    cost: roundTwo(accumulator.cost),
    sales: roundTwo(accumulator.sales),
    orders: roundTwo(accumulator.orders),
    ctr: accumulator.impressions > 0 ? roundTwo((accumulator.clicks / accumulator.impressions) * 100) : 0,
    cpc: accumulator.clicks > 0 ? roundTwo(accumulator.cost / accumulator.clicks) : 0,
    acos: acos === null ? null : roundTwo(acos),
    roas: accumulator.cost > 0 ? roundTwo(accumulator.sales / accumulator.cost) : 0,
    conversionRate: accumulator.clicks > 0 ? roundTwo((accumulator.orders / accumulator.clicks) * 100) : 0
  };
}

function createProfitEvidence(productEconomics: ProductEconomicsRow | null, context: AdGroupEconomics = UNMAPPED_AD_GROUP): ProfitEvidence {
  const source = { economicsAsin: context.asin, mappedAsins: context.mappedAsins, economicsSource: context.source };

  if (!productEconomics) {
    return {
      ...source,
      profitDataStatus: "MISSING_COST_DATA",
      targetProfit: null,
      maxAllowableAdSpend: null,
      targetAcos: null,
      breakEvenAcos: null,
      profitStatus: "NEEDS_COST_DATA"
    };
  }

  if (hasMissingCostData(productEconomics)) {
    return {
      ...source,
      profitDataStatus: "MISSING_COST_DATA",
      targetProfit: roundTwo(toNumber(productEconomics.target_profit)),
      maxAllowableAdSpend: null,
      targetAcos: null,
      breakEvenAcos: null,
      profitStatus: "NEEDS_COST_DATA"
    };
  }

  return {
    ...source,
    profitDataStatus: "AVAILABLE",
    targetProfit: roundTwo(toNumber(productEconomics.target_profit)),
    maxAllowableAdSpend: roundTwo(toNumber(productEconomics.max_allowable_ad_spend)),
    targetAcos: roundTwo(toNumber(productEconomics.target_acos)),
    breakEvenAcos: roundTwo(toNumber(productEconomics.break_even_acos)),
    profitStatus: productEconomics.profit_status
  };
}

function hasMissingCostData(productEconomics: ProductEconomicsRow | null): boolean {
  if (!productEconomics) return true;

  return (
    toNumber(productEconomics.selling_price) <= 0 ||
    toNumber(productEconomics.non_ad_cost) <= 0 ||
    toNumber(productEconomics.landed_cost) <= 0
  );
}

function getPriorityLabel(score: number): RecommendationItem["priorityLabel"] {
  if (score >= 85) {
    return "URGENT";
  }

  if (score >= 60) {
    return "HIGH";
  }

  if (score >= 30) {
    return "MEDIUM";
  }

  return "LOW";
}

function getConfidenceLabel(score: number): RecommendationItem["confidenceLabel"] {
  if (score >= 75) {
    return "HIGH";
  }

  if (score >= 45) {
    return "MEDIUM";
  }

  return "LOW";
}

function getConfidenceScore(input: {
  clicks: number;
  orders: number;
  productEconomicsAvailable: boolean;
  costDataAvailable: boolean;
  isScaleRecommendation: boolean;
}): number {
  let score = input.clicks < 3 ? 30 : input.clicks <= 7 ? 60 : 85;

  if (input.orders > 0) {
    score = Math.max(score, 60);
  }

  if (input.orders >= 2) {
    score = Math.max(score, 85);
  }

  if (!input.productEconomicsAvailable && input.isScaleRecommendation) {
    score -= 15;
  }

  if (!input.costDataAvailable) {
    score = Math.min(score, 40);
  }

  return roundTwo(clamp(score, 0, 100));
}

function getPriorityScore(input: {
  category: RecommendationCategory;
  evidence: Evidence;
  effectiveTargetAcos: number;
}): number {
  const { category, evidence, effectiveTargetAcos } = input;
  let score = 20;

  if (category === "negativeKeywordCandidates" || category === "negativeProductTargetCandidates") {
    score = 55 + evidence.cost * 1.2 + evidence.clicks * 2;
  } else if (category === "watchlistWasteTerms") {
    score = 35 + evidence.cost + evidence.clicks * 3;
  } else if (category === "exactMatchOpportunities" || category === "productTargetingOpportunities") {
    const acosGap = evidence.acos === null ? 0 : Math.max(effectiveTargetAcos - evidence.acos, 0);
    score = 60 + evidence.orders * 10 + evidence.sales * 0.05 + acosGap;
  } else if (category === "productPageCheckWarnings") {
    score = 50 + evidence.ctr + evidence.clicks;
  } else if (category === "bidDownCandidates") {
    const overTarget = evidence.acos === null ? 0 : Math.max(evidence.acos - effectiveTargetAcos, 0);
    score = 55 + overTarget * 0.6 + evidence.orders * 5;
  } else if (category === "profitRiskWarnings") {
    score = 90;
  }

  if (evidence.clicks < 3) {
    score = Math.min(score, 59);
  } else if (evidence.clicks < 8) {
    score = Math.min(score, 84);
  }

  return roundTwo(clamp(score, 0, 100));
}

function getRecommendationDetails(input: {
  evidence: Evidence;
  isAsinLike: boolean;
  effectiveTargetAcos: number;
  productEconomics: ProductEconomicsRow | null;
  costDataMissing: boolean;
}): {
  category: RecommendationCategory;
  recommendedAction: RecommendationAction;
  reason: string;
} {
  const { evidence, isAsinLike, effectiveTargetAcos, productEconomics, costDataMissing } = input;

  if (costDataMissing && evidence.orders > 0 && evidence.sales > 0) {
    return {
      category: "profitRiskWarnings",
      recommendedAction: "DO_NOT_SCALE_FIX_PRICE_COST_OR_BUNDLE",
      reason: "Product cost data is missing. Profit-safe PPC decisions are blocked until landed cost and fees are added."
    };
  }

  if (
    productEconomics?.profit_status === "FAIL" ||
    productEconomics?.profit_status === "NEEDS_COST_DATA" ||
    productEconomics?.profit_status === "NEEDS_INPUT" ||
    productEconomics?.profit_status === "BLOCKED"
  ) {
    return {
      category: "profitRiskWarnings",
      recommendedAction: "DO_NOT_SCALE_FIX_PRICE_COST_OR_BUNDLE",
      reason: "Product economics are failing the profit guardrail, so do not scale this traffic until price, cost, bundle, or charges are fixed."
    };
  }

  if (!isAsinLike && evidence.orders > 0 && evidence.sales > 0 && evidence.acos !== null && evidence.acos <= effectiveTargetAcos) {
    return {
      category: "exactMatchOpportunities",
      recommendedAction: "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
      reason: "This non-ASIN search term has sales and ACOS at or below the effective target ACOS."
    };
  }

  if (isAsinLike && evidence.orders > 0 && evidence.sales > 0 && evidence.acos !== null && evidence.acos <= effectiveTargetAcos) {
    return {
      category: "productTargetingOpportunities",
      recommendedAction: "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
      reason: "This ASIN-like search term has sales and ACOS at or below the effective target ACOS."
    };
  }

  if (evidence.ctr >= 15 && evidence.clicks >= 2 && evidence.sales === 0) {
    return {
      category: "productPageCheckWarnings",
      recommendedAction: "CHECK_LISTING_BEFORE_NEGATIVE",
      reason: "This term gets strong click-through but no sales, so check the listing page before adding it as a negative."
    };
  }

  if (evidence.sales === 0 && (evidence.clicks >= 8 || evidence.cost >= 25)) {
    return {
      category: isAsinLike ? "negativeProductTargetCandidates" : "negativeKeywordCandidates",
      recommendedAction: "ADD_NEGATIVE_AFTER_APPROVAL",
      reason: "This term has spend or clicks without sales, so it is a negative candidate after human approval."
    };
  }

  if (evidence.sales === 0 && evidence.clicks >= 3 && evidence.clicks <= 7) {
    return {
      category: "watchlistWasteTerms",
      recommendedAction: "MONITOR_DO_NOT_NEGATIVE_YET",
      reason: "This term has some clicks without sales, but the data is still too light for an immediate negative."
    };
  }

  if (evidence.orders > 0 && evidence.acos !== null && evidence.acos > effectiveTargetAcos) {
    return {
      category: "bidDownCandidates",
      recommendedAction: "LOWER_BID_AFTER_APPROVAL",
      reason: "This term converts, but ACOS is above the effective target ACOS, so consider lowering the bid after approval."
    };
  }

  return {
    category: "monitorOnlyTerms",
    recommendedAction: "MONITOR",
    reason: "No action is recommended yet. Keep monitoring until the term has clearer performance data."
  };
}

function getRecommendationType(category: RecommendationCategory): string {
  return category.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

function getApprovalTier(action: RecommendationAction): RecommendationItem["approvalTier"] {
  if (
    [
      "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
      "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
      "ADD_NEGATIVE_AFTER_APPROVAL",
      "LOWER_BID_AFTER_APPROVAL",
      "DO_NOT_SCALE_FIX_PRICE_COST_OR_BUNDLE"
    ].includes(action)
  ) {
    return "TIER_2";
  }

  return "TIER_1";
}

function getRiskLevel(category: RecommendationCategory): RecommendationItem["riskLevel"] {
  if (["negativeKeywordCandidates", "negativeProductTargetCandidates", "bidDownCandidates", "profitRiskWarnings"].includes(category)) {
    return "HIGH";
  }

  if (["watchlistWasteTerms", "productPageCheckWarnings"].includes(category)) {
    return "MEDIUM";
  }

  return "LOW";
}

type AdGroupEconomics = {
  economics: ProductEconomicsRow | null;
  /** Worst profit status across every ASIN in the ad group (scale-ups need ALL to pass). */
  gateProfitStatus: string | null;
  asin: string | null;
  mappedAsins: string[];
  source: "AD_GROUP_ASIN" | "NO_ECONOMICS_ROW" | "UNMAPPED";
};

const UNMAPPED_AD_GROUP: AdGroupEconomics = { economics: null, gateProfitStatus: null, asin: null, mappedAsins: [], source: "UNMAPPED" };

// Higher = worse. A scale-up needs "PASS" (0); anything else blocks it.
const PROFIT_STATUS_SEVERITY: Record<string, number> = { PASS: 0, RISK: 1, RETURN_RISK: 1, UNKNOWN: 2, NEEDS_INPUT: 3, NEEDS_COST_DATA: 4, FAIL: 5, BLOCKED: 6 };

function worstProfitStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  return statuses.reduce((worst, status) => ((PROFIT_STATUS_SEVERITY[status] ?? 2) > (PROFIT_STATUS_SEVERITY[worst] ?? 2) ? status : worst));
}

const ECONOMICS_COLUMNS =
  "asin, sku, selling_price, landed_cost, amazon_fee_estimate, shipping_fee_estimate, non_ad_cost, target_profit, max_allowable_ad_spend, target_acos, break_even_acos, profit_status, created_at";

// Returns eat margin that the cost sheet does not show. A product that customers send back
// often should not get a "scale this up" suggestion even if its unit economics look fine.
const RETURN_RISK_MIN_UNITS = 8; // below this the rate is noise
const RETURN_RISK_RATE_PCT = 15;
const RETURN_LOOKBACK_DAYS = 90;

/** ASIN -> return rate over the last 90 days, only for ASINs with enough sales to judge. */
async function loadHighReturnAsins(sellerId: string, asins: string[]): Promise<Map<string, { sold: number; returned: number; ratePct: number }>> {
  const flagged = new Map<string, { sold: number; returned: number; ratePct: number }>();
  if (asins.length === 0) return flagged;

  try {
    const since = new Date(Date.now() - RETURN_LOOKBACK_DAYS * 86_400_000).toISOString();
    const { data: orders, error: ordersError } = await supabase
      .from("amazon_sp_orders")
      .select("amazon_order_id")
      .eq("seller_id", sellerId)
      .gte("purchase_date", since)
      .limit(5000);
    if (ordersError) throw ordersError;

    const orderIds = ((orders ?? []) as { amazon_order_id: string | null }[]).map((row) => row.amazon_order_id).filter((id): id is string => Boolean(id));
    const sold = new Map<string, number>();
    for (let i = 0; i < orderIds.length; i += 100) {
      const { data: items, error: itemsError } = await supabase
        .from("amazon_sp_order_items")
        .select("asin, quantity_ordered")
        .in("amazon_order_id", orderIds.slice(i, i + 100))
        .in("asin", asins);
      if (itemsError) throw itemsError;
      for (const item of (items ?? []) as { asin: string | null; quantity_ordered: number | string | null }[]) {
        const asin = String(item.asin ?? "").trim().toUpperCase();
        if (asin) sold.set(asin, (sold.get(asin) ?? 0) + toNumber(item.quantity_ordered));
      }
    }

    const { data: returns, error: returnsError } = await supabase
      .from("amazon_sp_returns")
      .select("asin, quantity")
      .eq("seller_id", sellerId)
      .gte("return_date", since)
      .in("asin", asins)
      .limit(5000);
    if (returnsError) throw returnsError;
    const returned = new Map<string, number>();
    for (const row of (returns ?? []) as { asin: string | null; quantity: number | string | null }[]) {
      const asin = String(row.asin ?? "").trim().toUpperCase();
      if (asin) returned.set(asin, (returned.get(asin) ?? 0) + (toNumber(row.quantity) || 1));
    }

    for (const [asin, units] of sold.entries()) {
      const ret = returned.get(asin) ?? 0;
      const ratePct = units > 0 ? (ret / units) * 100 : 0;
      if (units >= RETURN_RISK_MIN_UNITS && ratePct >= RETURN_RISK_RATE_PCT) {
        flagged.set(asin, { sold: units, returned: ret, ratePct: roundTwo(ratePct) });
      }
    }
  } catch (error) {
    // Never block recommendations because the returns lookup failed; the other gates still apply.
    logger.warn("Could not check return rates for PPC recommendations.", { message: error instanceof Error ? error.message : String(error) });
  }
  return flagged;
}

/**
 * Links every ad group to the product(s) it advertises, and each product to ITS OWN latest
 * economics row. (Before this, one seller-wide "latest row" was applied to every search term, so
 * one failing product made every term in the account look like a profit risk.)
 */
async function loadAdGroupEconomics(input: {
  sellerId: string;
  startDate: string;
  endDate: string;
}): Promise<Map<string, AdGroupEconomics>> {
  const result = new Map<string, AdGroupEconomics>();

  const { data: advertised, error: advertisedError } = await supabase
    .from("amazon_ads_advertised_product_daily_metrics")
    .select("campaign_id, ad_group_id, advertised_asin, advertised_sku, cost")
    .eq("seller_id", input.sellerId)
    .gte("report_date", input.startDate)
    .lte("report_date", input.endDate)
    .limit(10000);

  if (advertisedError) {
    logSafeAmazonAdsSupabaseError("Could not load advertised products for PPC economics matching.", advertisedError);
    throw new Error("Could not load advertised products from Supabase.");
  }

  type AdvertisedRow = { campaign_id: string | null; ad_group_id: string | null; advertised_asin: string | null; advertised_sku: string | null; cost: number | string | null };
  const perGroup = new Map<string, Map<string, { cost: number; sku: string | null }>>();

  for (const row of (advertised ?? []) as AdvertisedRow[]) {
    const asin = String(row.advertised_asin ?? "").trim().toUpperCase();
    if (!row.campaign_id || !row.ad_group_id || !asin) continue;
    const key = `${row.campaign_id}::${row.ad_group_id}`;
    const asins = perGroup.get(key) ?? new Map<string, { cost: number; sku: string | null }>();
    const current = asins.get(asin) ?? { cost: 0, sku: null };
    current.cost += toNumber(row.cost);
    current.sku = current.sku ?? (row.advertised_sku ? String(row.advertised_sku) : null);
    asins.set(asin, current);
    perGroup.set(key, asins);
  }

  const allAsins = [...new Set([...perGroup.values()].flatMap((asins) => [...asins.keys()]))];
  const economicsByAsin = new Map<string, ProductEconomicsRow>();

  if (allAsins.length > 0) {
    const { data: economicsRows, error: economicsError } = await supabase
      .from("amazon_product_economics")
      .select(ECONOMICS_COLUMNS)
      .eq("seller_id", input.sellerId)
      .in("asin", allAsins)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (economicsError) {
      logSafeAmazonAdsSupabaseError("Could not load product economics for PPC recommendations.", economicsError);
      throw new Error("Could not load product economics from Supabase.");
    }

    // Rows arrive newest first, so the first one seen per ASIN is its latest.
    for (const row of (economicsRows ?? []) as unknown as ProductEconomicsRow[]) {
      const asin = String(row.asin ?? "").trim().toUpperCase();
      if (asin && !economicsByAsin.has(asin)) economicsByAsin.set(asin, row);
    }
  }

  const highReturnAsins = await loadHighReturnAsins(input.sellerId, allAsins);

  for (const [key, asins] of perGroup.entries()) {
    const ranked = [...asins.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([asin]) => asin);
    const primary = ranked[0] ?? null;
    const primaryEconomics = primary ? economicsByAsin.get(primary) ?? null : null;
    const statuses: string[] = ranked.map((asin) => economicsByAsin.get(asin)?.profit_status ?? "NEEDS_COST_DATA");
    // A high return rate on any advertised product keeps the group out of "scale up" (needs PASS).
    if (ranked.some((asin) => highReturnAsins.has(asin))) statuses.push("RETURN_RISK");

    result.set(key, {
      economics: primaryEconomics,
      gateProfitStatus: worstProfitStatus(statuses),
      asin: primary,
      mappedAsins: ranked,
      source: primaryEconomics ? "AD_GROUP_ASIN" : "NO_ECONOMICS_ROW"
    });
  }

  return result;
}

async function listSearchTermMetrics(input: {
  sellerId: string;
  startDate: string;
  endDate: string;
}): Promise<SearchTermMetricRow[]> {
  const { data, error } = await supabase
    .from("amazon_ads_search_term_daily_metrics")
    .select("report_date, campaign_id, campaign_name, ad_group_id, ad_group_name, search_term, impressions, clicks, cost, sales, orders")
    .eq("seller_id", input.sellerId)
    .gte("report_date", input.startDate)
    .lte("report_date", input.endDate)
    .limit(10000);

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load search term metrics for PPC recommendations.", error);
    throw new Error("Could not load search term metrics from Supabase.");
  }

  return (data ?? []) as SearchTermMetricRow[];
}

export async function getAmazonAdsPpcRecommendations(input: {
  sellerId: string;
  days: number;
  targetAcos: number;
}): Promise<PpcRecommendationResponse> {
  const { startDate, endDate } = getAmazonAdsPpcRecommendationDateRange(input.days);
  const [adGroupEconomics, metricRows] = await Promise.all([
    loadAdGroupEconomics({
      sellerId: input.sellerId,
      startDate,
      endDate
    }),
    listSearchTermMetrics({
      sellerId: input.sellerId,
      startDate,
      endDate
    })
  ]);
  const categories: Record<RecommendationCategory, RecommendationItem[]> = {
    exactMatchOpportunities: [],
    productTargetingOpportunities: [],
    watchlistWasteTerms: [],
    negativeKeywordCandidates: [],
    negativeProductTargetCandidates: [],
    bidDownCandidates: [],
    productPageCheckWarnings: [],
    profitRiskWarnings: [],
    monitorOnlyTerms: []
  };
  const grouped = new Map<string, MetricAccumulator>();
  const heldBackTerms: HeldBackTerm[] = [];
  let termsWithoutEconomics = 0;

  for (const row of metricRows) {
    const searchTerm = row.search_term ?? "";
    const campaignId = row.campaign_id ?? "";
    const adGroupId = row.ad_group_id ?? "";

    if (!searchTerm || !campaignId || !adGroupId) {
      continue;
    }

    const key = `${searchTerm}::${campaignId}::${adGroupId}`;
    const accumulator =
      grouped.get(key) ??
      {
        dates: new Set<string>(),
        searchTerm,
        campaignId,
        campaignName: row.campaign_name,
        adGroupId,
        adGroupName: row.ad_group_name,
        impressions: 0,
        clicks: 0,
        cost: 0,
        sales: 0,
        orders: 0
      };

    accumulator.impressions += toNumber(row.impressions);
    accumulator.clicks += toNumber(row.clicks);
    accumulator.cost += toNumber(row.cost);
    accumulator.sales += toNumber(row.sales);
    accumulator.orders += toNumber(row.orders);
    if (row.report_date && (toNumber(row.impressions) > 0 || toNumber(row.clicks) > 0)) {
      accumulator.dates.add(String(row.report_date).slice(0, 10));
    }
    accumulator.campaignName = accumulator.campaignName ?? row.campaign_name;
    accumulator.adGroupName = accumulator.adGroupName ?? row.ad_group_name;
    grouped.set(key, accumulator);
  }

  for (const accumulator of grouped.values()) {
    const evidence = createEvidence(accumulator);
    const isAsinLike = isAsinLikeSearchTerm(accumulator.searchTerm);
    // Each term is judged against the economics of the product its OWN ad group advertises.
    const economicsContext = adGroupEconomics.get(`${accumulator.campaignId}::${accumulator.adGroupId}`) ?? UNMAPPED_AD_GROUP;
    const productEconomics = economicsContext.economics;
    const costDataMissing = !productEconomics || hasMissingCostData(productEconomics);
    const productTargetAcos = toNumber(productEconomics?.target_acos);
    const effectiveTargetAcos = roundTwo(
      costDataMissing
        ? Math.min(input.targetAcos, 20)
        : productTargetAcos > 0
        ? Math.min(productTargetAcos, input.targetAcos)
        : input.targetAcos
    );
    termsWithoutEconomics += costDataMissing ? 1 : 0;
    const rawDetails = getRecommendationDetails({
      evidence,
      isAsinLike,
      effectiveTargetAcos,
      productEconomics,
      costDataMissing
    });
    // Blueprint §12 data-maturity gate: thin data never becomes an approval-worthy action.
    const sortedDates = [...accumulator.dates].sort();
    const dataMaturity = evaluatePpcDataMaturity({
      category: rawDetails.category,
      clicks: evidence.clicks,
      observedDays: sortedDates.length,
      spanDays: sortedDates.length > 0 ? inclusiveSpanDays(sortedDates[0], sortedDates[sortedDates.length - 1]) : null,
      // Scale-ups need EVERY product in the ad group to pass, not just the top-spend one.
      profitStatus: economicsContext.gateProfitStatus
    });
    let details: { category: RecommendationCategory; recommendedAction: RecommendationAction; reason: string } = rawDetails;

    if (dataMaturity.status === "HELD_BACK" && dataMaturity.downgradeTo) {
      details = {
        category: dataMaturity.downgradeTo,
        recommendedAction: dataMaturity.downgradeTo === "watchlistWasteTerms" ? "MONITOR_DO_NOT_NEGATIVE_YET" : "MONITOR",
        reason: `Held back, not enough mature data yet (${dataMaturity.reasons.join("; ")}). Original suggestion: ${rawDetails.recommendedAction}.`
      };
      heldBackTerms.push({
        searchTerm: accumulator.searchTerm,
        campaignId: accumulator.campaignId,
        adGroupId: accumulator.adGroupId,
        originalCategory: rawDetails.category,
        originalAction: rawDetails.recommendedAction,
        reasons: dataMaturity.reasons,
        blueprintRule: dataMaturity.blueprintRule
      });
    }
    const isScaleRecommendation = ["exactMatchOpportunities", "productTargetingOpportunities"].includes(details.category);
    const priorityScore = getPriorityScore({
      category: details.category,
      evidence,
      effectiveTargetAcos
    });
    const confidenceScore = getConfidenceScore({
      clicks: evidence.clicks,
      orders: evidence.orders,
      productEconomicsAvailable: Boolean(productEconomics),
      costDataAvailable: !costDataMissing,
      isScaleRecommendation
    });
    const item: RecommendationItem = {
      searchTerm: accumulator.searchTerm,
      campaignId: accumulator.campaignId,
      campaignName: accumulator.campaignName,
      adGroupId: accumulator.adGroupId,
      adGroupName: accumulator.adGroupName,
      recommendationType: getRecommendationType(details.category),
      recommendedAction: details.recommendedAction,
      priorityScore,
      priorityLabel: getPriorityLabel(priorityScore),
      confidenceScore,
      confidenceLabel: getConfidenceLabel(confidenceScore),
      approvalTier: getApprovalTier(details.recommendedAction),
      requiresApproval: true,
      riskLevel: getRiskLevel(details.category),
      reason: details.reason,
      evidence,
      profitEvidence: createProfitEvidence(productEconomics, economicsContext),
      ruleVersion: "profit_ppc_v1",
      strategyVersion: "ai_cgo_v2_2_shadow_mode",
      dataMaturity
    };

    categories[details.category].push(item);
  }

  for (const category of Object.keys(categories) as RecommendationCategory[]) {
    categories[category].sort((a, b) => b.priorityScore - a.priorityScore);
  }

  // Account-level summary. Each recommendation above already used its OWN product's economics;
  // effectiveTargetAcos here is just the ceiling the caller asked for.
  const effectiveTargetAcos = roundTwo(input.targetAcos);
  const profitDataStatus: PpcRecommendationResponse["profitDataStatus"] = termsWithoutEconomics > 0 ? "MISSING_COST_DATA" : "AVAILABLE";
  const warnings =
    termsWithoutEconomics > 0
      ? [
          `${termsWithoutEconomics} of ${grouped.size} search terms belong to ad groups with no usable product cost data (or not yet linked to a product). Profit-safe actions are blocked for those terms until landed cost and fees are added.`
        ]
      : [];

  return {
    ok: true,
    sellerId: input.sellerId,
    days: input.days,
    targetAcos: input.targetAcos,
    effectiveTargetAcos,
    effectiveMode: "READ_ONLY_SHADOW_MODE",
    summary: {
      totalGroupedTerms: grouped.size,
      exactMatchOpportunities: categories.exactMatchOpportunities.length,
      productTargetingOpportunities: categories.productTargetingOpportunities.length,
      watchlistWasteTerms: categories.watchlistWasteTerms.length,
      negativeKeywordCandidates: categories.negativeKeywordCandidates.length,
      negativeProductTargetCandidates: categories.negativeProductTargetCandidates.length,
      bidDownCandidates: categories.bidDownCandidates.length,
      productPageCheckWarnings: categories.productPageCheckWarnings.length,
      profitRiskWarnings: categories.profitRiskWarnings.length,
      monitorOnlyTerms: categories.monitorOnlyTerms.length,
      heldBackForImmatureData: heldBackTerms.length,
      termsWithoutProductEconomics: termsWithoutEconomics
    },
    profitDataStatus,
    ...categories,
    heldBackTerms: heldBackTerms.slice(0, 200),
    warnings
  };
}

function getRecommendationEntityType(item: RecommendationItem): string {
  return isAsinLikeSearchTerm(item.searchTerm) ? "ASIN" : "SEARCH_TERM";
}

function getRecommendationAsin(item: RecommendationItem): string | null {
  return isAsinLikeSearchTerm(item.searchTerm) ? item.searchTerm.toUpperCase() : null;
}

async function recommendationAlreadyExists(input: {
  sellerId: string;
  item: RecommendationItem;
  dataStartDate: string;
  dataEndDate: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_recommendations")
    .select("id")
    .eq("seller_id", input.sellerId)
    .eq("entity_value", input.item.searchTerm)
    .eq("recommended_action", input.item.recommendedAction)
    .eq("rule_version", input.item.ruleVersion)
    .eq("data_start_date", input.dataStartDate)
    .eq("data_end_date", input.dataEndDate)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not check existing AI recommendation duplicate.", error);
    throw new Error("Could not check existing AI recommendation duplicate.");
  }

  return Boolean(data);
}

export async function saveAmazonAdsPpcRecommendations(input: {
  sellerId: string;
  recommendations: PpcRecommendationResponse;
  dataStartDate: string;
  dataEndDate: string;
}): Promise<{ savedCount: number; skippedDuplicateCount: number }> {
  let savedCount = 0;
  let skippedDuplicateCount = 0;

  for (const category of SAVEABLE_RECOMMENDATION_CATEGORIES) {
    for (const item of input.recommendations[category]) {
      const exists = await recommendationAlreadyExists({
        sellerId: input.sellerId,
        item,
        dataStartDate: input.dataStartDate,
        dataEndDate: input.dataEndDate
      });

      if (exists) {
        skippedDuplicateCount += 1;
        continue;
      }

      const { error } = await supabase.from("ai_recommendations").insert({
        seller_id: input.sellerId,
        source: "PPC_RECOMMENDATION_BRAIN",
        recommendation_type: item.recommendationType,
        recommended_action: item.recommendedAction,
        entity_type: getRecommendationEntityType(item),
        entity_value: item.searchTerm,
        campaign_id: item.campaignId,
        campaign_name: item.campaignName,
        ad_group_id: item.adGroupId,
        ad_group_name: item.adGroupName,
        sku: null,
        asin: getRecommendationAsin(item),
        priority_score: item.priorityScore,
        priority_label: item.priorityLabel,
        confidence_score: item.confidenceScore,
        confidence_label: item.confidenceLabel,
        approval_tier: item.approvalTier,
        requires_approval: item.requiresApproval,
        risk_level: item.riskLevel,
        expected_profit_impact: null,
        reason: item.reason,
        evidence: { ...item.evidence, dataMaturity: item.dataMaturity },
        profit_evidence: item.profitEvidence,
        status: "NEW",
        rule_version: item.ruleVersion,
        strategy_version: item.strategyVersion,
        data_start_date: input.dataStartDate,
        data_end_date: input.dataEndDate,
        updated_at: new Date().toISOString()
      });

      if (error) {
        if (error.code === "23505") {
          skippedDuplicateCount += 1;
          continue;
        }

        logSafeAmazonAdsSupabaseError("Could not save AI recommendation.", error);
        throw new Error("Could not save AI recommendations in Supabase.");
      }

      savedCount += 1;
    }
  }

  return {
    savedCount,
    skippedDuplicateCount
  };
}
