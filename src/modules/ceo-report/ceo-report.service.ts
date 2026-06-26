import { supabase } from "../../db/supabase";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { ProductEconomicsRow, ProductProfitStatus } from "../product-economics/product-economics.types";
import { AiRecommendationRow, AiRecommendationStatus } from "../recommendations/recommendations.types";

type BusinessStatus = "GOOD" | "WATCH" | "RISK";
type ProfitDataStatus = "AVAILABLE" | "MISSING";
type Priority = "LOW" | "MEDIUM" | "HIGH";

type MetricRow = {
  impressions: number | string | null;
  clicks: number | string | null;
  cost: number | string | null;
  sales: number | string | null;
  orders: number | string | null;
};

type CampaignMetricRow = MetricRow;

type SearchTermMetricRow = MetricRow & {
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  search_term: string;
};

type MetricSummary = {
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

type MetricTotals = {
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
};

type SearchTermHighlight = MetricSummary & {
  searchTerm: string;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
};

type RecommendationListItem = {
  id: string;
  recommendationType: string;
  recommendedAction: string;
  entityValue: string | null;
  priorityLabel: string;
  confidenceLabel: string;
  riskLevel: string;
  reason: string;
};

type RecommendationSummary = {
  newCount: number;
  approvedCount: number;
  rejectedCount: number;
  monitoringCount: number;
  completedManuallyCount: number;
};

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeErrorMessage(message: string): string {
  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.AMAZON_LWA_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_SECRET,
    env.ENCRYPTION_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (safeMessage, secretValue) => safeMessage.replaceAll(secretValue, "[REDACTED]"),
    message
  );
}

function getDateDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function summarizeMetrics(rows: MetricRow[]): MetricSummary {
  const totals = rows.reduce<MetricTotals>(
    (accumulator, row) => ({
      impressions: accumulator.impressions + toNumber(row.impressions),
      clicks: accumulator.clicks + toNumber(row.clicks),
      cost: accumulator.cost + toNumber(row.cost),
      sales: accumulator.sales + toNumber(row.sales),
      orders: accumulator.orders + toNumber(row.orders)
    }),
    {
      impressions: 0,
      clicks: 0,
      cost: 0,
      sales: 0,
      orders: 0
    }
  );

  return {
    impressions: roundTwo(totals.impressions),
    clicks: roundTwo(totals.clicks),
    cost: roundTwo(totals.cost),
    sales: roundTwo(totals.sales),
    orders: roundTwo(totals.orders),
    ctr: totals.impressions > 0 ? roundTwo((totals.clicks / totals.impressions) * 100) : 0,
    cpc: totals.clicks > 0 ? roundTwo(totals.cost / totals.clicks) : 0,
    acos: totals.sales > 0 ? roundTwo((totals.cost / totals.sales) * 100) : null,
    roas: totals.cost > 0 ? roundTwo(totals.sales / totals.cost) : 0,
    conversionRate: totals.clicks > 0 ? roundTwo((totals.orders / totals.clicks) * 100) : 0
  };
}

function isAsinLike(searchTerm: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(searchTerm.trim());
}

function groupSearchTerms(rows: SearchTermMetricRow[]): SearchTermHighlight[] {
  const grouped = new Map<string, SearchTermMetricRow & MetricRow>();

  for (const row of rows) {
    if (!row.search_term || !row.campaign_id || !row.ad_group_id) {
      continue;
    }

    const key = `${row.search_term}::${row.campaign_id}::${row.ad_group_id}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, { ...row });
      continue;
    }

    existing.impressions = toNumber(existing.impressions) + toNumber(row.impressions);
    existing.clicks = toNumber(existing.clicks) + toNumber(row.clicks);
    existing.cost = toNumber(existing.cost) + toNumber(row.cost);
    existing.sales = toNumber(existing.sales) + toNumber(row.sales);
    existing.orders = toNumber(existing.orders) + toNumber(row.orders);
    existing.campaign_name = existing.campaign_name ?? row.campaign_name;
    existing.ad_group_name = existing.ad_group_name ?? row.ad_group_name;
  }

  return Array.from(grouped.values()).map((row) => ({
    searchTerm: row.search_term,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    ...summarizeMetrics([row])
  }));
}

function getProfitReason(productEconomics: ProductEconomicsRow | null): string {
  if (!productEconomics) {
    return "Product economics are missing. Add costs, price, and target profit before scaling ads.";
  }

  if (productEconomics.profit_status === "PASS") {
    return "Product economics currently protect the required net profit.";
  }

  if (productEconomics.profit_status === "RISK") {
    return "Product can meet profit floor, but available ad room is low.";
  }

  if (productEconomics.profit_status === "FAIL") {
    return "Product cannot meet required net profit after non-ad costs. Fix price, cost, bundle, or charges before scaling.";
  }

  return "Product economics are available but profit status is unknown.";
}

function buildProfitGuardrail(productEconomics: ProductEconomicsRow | null) {
  return {
    profitDataStatus: productEconomics ? "AVAILABLE" as ProfitDataStatus : "MISSING" as ProfitDataStatus,
    sellingPrice: roundTwo(toNumber(productEconomics?.selling_price)),
    targetProfit: roundTwo(toNumber(productEconomics?.target_profit)),
    nonAdCost: roundTwo(toNumber(productEconomics?.non_ad_cost)),
    maxAllowableAdSpend: roundTwo(toNumber(productEconomics?.max_allowable_ad_spend)),
    targetAcos: roundTwo(toNumber(productEconomics?.target_acos)),
    breakEvenAcos: roundTwo(toNumber(productEconomics?.break_even_acos)),
    profitStatus: productEconomics?.profit_status ?? "UNKNOWN" as ProductProfitStatus,
    reason: getProfitReason(productEconomics)
  };
}

function buildExecutiveSummary(input: {
  productEconomics: ProductEconomicsRow | null;
  ppcSnapshot: MetricSummary;
}) {
  const profitStatus = input.productEconomics?.profit_status ?? "UNKNOWN";
  let businessStatus: BusinessStatus = "WATCH";
  let oneLineAdvice = "Keep monitoring until more data is available.";

  if (!input.productEconomics) {
    businessStatus = "WATCH";
    oneLineAdvice = "Add product economics before scaling ads.";
  } else if (profitStatus === "FAIL") {
    businessStatus = "RISK";
    oneLineAdvice = "Do not scale ads until price, cost, bundle, or charges are fixed.";
  } else if (
    input.ppcSnapshot.sales > 0 &&
    input.ppcSnapshot.acos !== null &&
    input.ppcSnapshot.acos <= toNumber(input.productEconomics.target_acos)
  ) {
    businessStatus = "GOOD";
    oneLineAdvice = "There are profit-safe PPC opportunities, but keep approval-first shadow mode.";
  } else if (input.ppcSnapshot.cost > 0 && input.ppcSnapshot.sales === 0) {
    businessStatus = "WATCH";
    oneLineAdvice = "PPC is spending without sales. Monitor terms and check listing quality.";
  }

  return {
    headline: `${businessStatus}: ${oneLineAdvice}`,
    businessStatus,
    profitStatus,
    oneLineAdvice
  };
}

function toRecommendationItem(row: AiRecommendationRow): RecommendationListItem {
  return {
    id: row.id,
    recommendationType: row.recommendation_type,
    recommendedAction: row.recommended_action,
    entityValue: row.entity_value,
    priorityLabel: row.priority_label ?? "LOW",
    confidenceLabel: row.confidence_label ?? "LOW",
    riskLevel: row.risk_level ?? "LOW",
    reason: row.reason
  };
}

function sortByPriority(rows: AiRecommendationRow[]): AiRecommendationRow[] {
  return [...rows].sort((a, b) => toNumber(b.priority_score) - toNumber(a.priority_score));
}

function sortByCreatedAt(rows: AiRecommendationRow[]): AiRecommendationRow[] {
  return [...rows].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

function getRecommendationSummary(rows: AiRecommendationRow[]): RecommendationSummary {
  return {
    newCount: rows.filter((row) => row.status === "NEW").length,
    approvedCount: rows.filter((row) => row.status === "APPROVED").length,
    rejectedCount: rows.filter((row) => row.status === "REJECTED").length,
    monitoringCount: rows.filter((row) => row.status === "MONITORING").length,
    completedManuallyCount: rows.filter((row) => row.status === "COMPLETED_MANUALLY").length
  };
}

function buildNextBestAction(input: {
  newRecommendations: AiRecommendationRow[];
  profitStatus: ProductProfitStatus;
  listingCheckWarnings: RecommendationListItem[];
  monitoringItems: RecommendationListItem[];
}): { title: string; reason: string; priority: Priority } {
  const hasNewTier2ScaleRecommendation = input.newRecommendations.some(
    (row) =>
      row.approval_tier === "TIER_2" &&
      ["EXACT_MATCH_OPPORTUNITIES", "PRODUCT_TARGETING_OPPORTUNITIES"].includes(row.recommendation_type)
  );

  if (hasNewTier2ScaleRecommendation) {
    return {
      title: "Review scale opportunity",
      reason: "There are new Tier 2 scale recommendations waiting for approval.",
      priority: "HIGH"
    };
  }

  if (input.profitStatus === "FAIL") {
    return {
      title: "Fix product economics",
      reason: "The latest product economics fail the profit guardrail.",
      priority: "HIGH"
    };
  }

  if (input.listingCheckWarnings.length > 0) {
    return {
      title: "Check listing before cutting traffic",
      reason: "Some terms have strong click-through but no sales.",
      priority: "MEDIUM"
    };
  }

  if (input.monitoringItems.length > 0) {
    return {
      title: "Wait for more data",
      reason: "Monitoring items need more data before action.",
      priority: "LOW"
    };
  }

  return {
    title: "No urgent action today",
    reason: "No high-priority shadow-mode action is waiting.",
    priority: "LOW"
  };
}

async function loadLatestProductEconomics(sellerId: string): Promise<ProductEconomicsRow | null> {
  const { data, error } = await supabase
    .from("amazon_product_economics")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ProductEconomicsRow>();

  if (error) {
    logger.warn("Could not load product economics for CEO report.", {
      message: sanitizeErrorMessage(error.message),
      code: sanitizeErrorMessage(error.code)
    });
    throw new Error("Could not load product economics.");
  }

  return data;
}

async function loadCampaignMetrics(input: {
  sellerId: string;
  startDate: string;
  endDate: string;
}): Promise<CampaignMetricRow[]> {
  const { data, error } = await supabase
    .from("amazon_ads_campaign_daily_metrics")
    .select("impressions, clicks, cost, sales, orders")
    .eq("seller_id", input.sellerId)
    .gte("report_date", input.startDate)
    .lte("report_date", input.endDate)
    .limit(10000);

  if (error) {
    logger.warn("Could not load campaign metrics for CEO report.", {
      message: sanitizeErrorMessage(error.message),
      code: sanitizeErrorMessage(error.code)
    });
    throw new Error("Could not load campaign metrics.");
  }

  return (data ?? []) as CampaignMetricRow[];
}

async function loadSearchTermMetrics(input: {
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
    logger.warn("Could not load search term metrics for CEO report.", {
      message: sanitizeErrorMessage(error.message),
      code: sanitizeErrorMessage(error.code)
    });
    throw new Error("Could not load search term metrics.");
  }

  return (data ?? []) as SearchTermMetricRow[];
}

async function loadRecommendations(sellerId: string): Promise<AiRecommendationRow[]> {
  const { data, error } = await supabase
    .from("ai_recommendations")
    .select(
      "id, recommendation_type, recommended_action, entity_value, priority_score, priority_label, confidence_label, risk_level, reason, status, approval_tier, created_at"
    )
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    logger.warn("Could not load recommendations for CEO report.", {
      message: sanitizeErrorMessage(error.message),
      code: sanitizeErrorMessage(error.code)
    });
    throw new Error("Could not load recommendations.");
  }

  return (data ?? []) as AiRecommendationRow[];
}

export async function getDailyCeoReport(input: { sellerId: string; days: number }) {
  const endDate = getDateDaysAgo(1);
  const startDate = getDateDaysAgo(input.days);
  const reportDate = new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];
  const [productEconomics, campaignRows, searchTermRows, recommendations] = await Promise.all([
    loadLatestProductEconomics(input.sellerId),
    loadCampaignMetrics({ sellerId: input.sellerId, startDate, endDate }),
    loadSearchTermMetrics({ sellerId: input.sellerId, startDate, endDate }),
    loadRecommendations(input.sellerId)
  ]);

  if (!productEconomics) {
    warnings.push("Product economics missing. Add product economics before scaling ads.");
  }

  const ppcSnapshot = summarizeMetrics(campaignRows);
  const searchTerms = groupSearchTerms(searchTermRows);
  const newRecommendations = recommendations.filter((row) => row.status === "NEW");
  const approvedRecommendations = recommendations.filter((row) => row.status === "APPROVED");
  const monitoringRecommendations = recommendations.filter((row) => row.status === "MONITORING");
  const todayTopActions = sortByPriority(newRecommendations).slice(0, 5).map(toRecommendationItem);
  const scaleOpportunities = sortByPriority(
    recommendations.filter(
      (row) =>
        ["NEW", "APPROVED"].includes(row.status ?? "") &&
        ["EXACT_MATCH_OPPORTUNITIES", "PRODUCT_TARGETING_OPPORTUNITIES"].includes(row.recommendation_type)
    )
  ).slice(0, 5).map(toRecommendationItem);
  const watchlistRisks = sortByPriority(
    recommendations.filter((row) =>
      [
        "WATCHLIST_WASTE_TERMS",
        "NEGATIVE_KEYWORD_CANDIDATES",
        "NEGATIVE_PRODUCT_TARGET_CANDIDATES"
      ].includes(row.recommendation_type)
    )
  ).slice(0, 5).map(toRecommendationItem);
  const listingCheckWarnings = sortByPriority(
    recommendations.filter((row) => row.recommendation_type === "PRODUCT_PAGE_CHECK_WARNINGS")
  ).slice(0, 5).map(toRecommendationItem);
  const profitRiskAlerts = sortByPriority(
    recommendations.filter((row) => row.recommendation_type === "PROFIT_RISK_WARNINGS")
  ).slice(0, 5).map(toRecommendationItem);
  const pendingApprovals = sortByCreatedAt(newRecommendations).slice(0, 10).map(toRecommendationItem);
  const approvedShadowActions = sortByCreatedAt(approvedRecommendations).slice(0, 10).map(toRecommendationItem);
  const monitoringItems = sortByCreatedAt(monitoringRecommendations).slice(0, 10).map(toRecommendationItem);
  const profitGuardrail = buildProfitGuardrail(productEconomics);

  return {
    ok: true,
    sellerId: input.sellerId,
    days: input.days,
    mode: "CEO_REPORT_SHADOW_MODE",
    reportDate,
    executiveSummary: buildExecutiveSummary({
      productEconomics,
      ppcSnapshot
    }),
    profitGuardrail,
    ppcSnapshot,
    searchTermHighlights: {
      topConvertingTerms: searchTerms
        .filter((term) => term.orders > 0 || term.sales > 0)
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 10),
      topSpendNoSaleTerms: searchTerms
        .filter((term) => term.cost > 0 && term.sales === 0)
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10),
      asinLikeTerms: searchTerms
        .filter((term) => isAsinLike(term.searchTerm))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10),
      highCtrNoSaleTerms: searchTerms
        .filter((term) => term.ctr >= 15 && term.clicks >= 2 && term.sales === 0)
        .sort((a, b) => b.ctr - a.ctr)
        .slice(0, 10)
    },
    recommendationSummary: getRecommendationSummary(recommendations),
    todayTopActions,
    scaleOpportunities,
    watchlistRisks,
    listingCheckWarnings,
    profitRiskAlerts,
    pendingApprovals,
    approvedShadowActions,
    monitoringItems,
    nextBestAction: buildNextBestAction({
      newRecommendations,
      profitStatus: profitGuardrail.profitStatus,
      listingCheckWarnings,
      monitoringItems
    }),
    warnings
  };
}
