import { supabase } from "../../db/supabase";
import { ProductEconomicsRow, ProductProfitStatus } from "../product-economics/product-economics.types";
import { logSafeAmazonAdsSupabaseError } from "./amazon-ads-client.service";

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
  profitDataStatus: "AVAILABLE" | "MISSING";
  targetProfit: number | null;
  maxAllowableAdSpend: number | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  profitStatus: ProductProfitStatus | null;
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
};

export type PpcRecommendationResponse = {
  ok: true;
  sellerId: string;
  days: number;
  targetAcos: number;
  effectiveTargetAcos: number;
  effectiveMode: "READ_ONLY_SHADOW_MODE";
  summary: Record<string, number>;
  profitDataStatus: "AVAILABLE" | "MISSING";
  exactMatchOpportunities: RecommendationItem[];
  productTargetingOpportunities: RecommendationItem[];
  watchlistWasteTerms: RecommendationItem[];
  negativeKeywordCandidates: RecommendationItem[];
  negativeProductTargetCandidates: RecommendationItem[];
  bidDownCandidates: RecommendationItem[];
  productPageCheckWarnings: RecommendationItem[];
  profitRiskWarnings: RecommendationItem[];
  monitorOnlyTerms: RecommendationItem[];
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

function createProfitEvidence(productEconomics: ProductEconomicsRow | null): ProfitEvidence {
  if (!productEconomics) {
    return {
      profitDataStatus: "MISSING",
      targetProfit: null,
      maxAllowableAdSpend: null,
      targetAcos: null,
      breakEvenAcos: null,
      profitStatus: null
    };
  }

  return {
    profitDataStatus: "AVAILABLE",
    targetProfit: roundTwo(toNumber(productEconomics.target_profit)),
    maxAllowableAdSpend: roundTwo(toNumber(productEconomics.max_allowable_ad_spend)),
    targetAcos: roundTwo(toNumber(productEconomics.target_acos)),
    breakEvenAcos: roundTwo(toNumber(productEconomics.break_even_acos)),
    profitStatus: productEconomics.profit_status
  };
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
}): {
  category: RecommendationCategory;
  recommendedAction: RecommendationAction;
  reason: string;
} {
  const { evidence, isAsinLike, effectiveTargetAcos, productEconomics } = input;

  if (productEconomics?.profit_status === "FAIL") {
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

async function getLatestProductEconomics(sellerId: string): Promise<ProductEconomicsRow | null> {
  const { data, error } = await supabase
    .from("amazon_product_economics")
    .select("target_profit, max_allowable_ad_spend, target_acos, break_even_acos, profit_status, created_at")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ProductEconomicsRow>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load product economics for PPC recommendations.", error);
    throw new Error("Could not load product economics from Supabase.");
  }

  return data;
}

async function listSearchTermMetrics(input: {
  sellerId: string;
  startDate: string;
  endDate: string;
}): Promise<SearchTermMetricRow[]> {
  const { data, error } = await supabase
    .from("amazon_ads_search_term_daily_metrics")
    .select("campaign_id, campaign_name, ad_group_id, ad_group_name, search_term, impressions, clicks, cost, sales, orders")
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
  const [productEconomics, metricRows] = await Promise.all([
    getLatestProductEconomics(input.sellerId),
    listSearchTermMetrics({
      sellerId: input.sellerId,
      startDate,
      endDate
    })
  ]);
  const productTargetAcos = toNumber(productEconomics?.target_acos);
  const effectiveTargetAcos = roundTwo(
    productEconomics && productTargetAcos > 0
      ? Math.min(productTargetAcos, input.targetAcos)
      : input.targetAcos
  );
  const profitDataStatus = productEconomics ? "AVAILABLE" : "MISSING";
  const warnings = productEconomics
    ? []
    : ["Product economics missing. Profit-safe scaling cannot be confirmed."];
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
    accumulator.campaignName = accumulator.campaignName ?? row.campaign_name;
    accumulator.adGroupName = accumulator.adGroupName ?? row.ad_group_name;
    grouped.set(key, accumulator);
  }

  for (const accumulator of grouped.values()) {
    const evidence = createEvidence(accumulator);
    const isAsinLike = isAsinLikeSearchTerm(accumulator.searchTerm);
    const details = getRecommendationDetails({
      evidence,
      isAsinLike,
      effectiveTargetAcos,
      productEconomics
    });
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
      profitEvidence: createProfitEvidence(productEconomics),
      ruleVersion: "profit_ppc_v1",
      strategyVersion: "ai_cgo_v2_2_shadow_mode"
    };

    categories[details.category].push(item);
  }

  for (const category of Object.keys(categories) as RecommendationCategory[]) {
    categories[category].sort((a, b) => b.priorityScore - a.priorityScore);
  }

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
      monitorOnlyTerms: categories.monitorOnlyTerms.length
    },
    profitDataStatus,
    ...categories,
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
        evidence: item.evidence,
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
