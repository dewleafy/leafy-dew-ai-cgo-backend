import { logger } from "../../utils/logger";
import {
  getAmazonAdsPpcRecommendations,
  getAmazonAdsPpcRecommendationDateRange,
  PpcRecommendationResponse,
  RecommendationCategory,
  RecommendationItem
} from "../amazon-ads/amazon-ads-ppc-recommendation.service";
import { savedRecommendationAllowed } from "../amazon-ads/ppc-data-maturity";
import { getDailyCeoReport } from "../ceo-report/ceo-report.service";
import {
  getCostCompletionQueue,
  listProductEconomics
} from "../product-economics/product-economics.service";
import { CostCompletionQueueRow, SafeProductEconomicsRow } from "../product-economics/product-economics.types";
import { listAiRecommendations } from "../recommendations/recommendations.service";
import { SafeAiRecommendationRow } from "../recommendations/recommendations.types";
import {
  ActionLedgerActionType,
  ActionLedgerApprovalTier,
  ActionLedgerConfidenceLabel,
  ActionLedgerEntityType,
  ActionLedgerInput,
  ActionLedgerRiskLevel,
  SafeActionLedgerRow
} from "./action-ledger.types";
import { ensureActionLedgerAction } from "./action-ledger.service";

type SyncCandidate = ActionLedgerInput & {
  sourceName: "PPC_RECOMMENDATIONS" | "PRODUCT_ECONOMICS" | "CEO_REPORT";
};

export type ActionLedgerSyncResult = {
  ok: true;
  sellerId: string;
  createdCount: number;
  existingCount: number;
  totalScanned: number;
  rows: SafeActionLedgerRow[];
};

const PPC_RECOMMENDATION_CATEGORIES: RecommendationCategory[] = [
  "exactMatchOpportunities",
  "productTargetingOpportunities",
  "watchlistWasteTerms",
  "negativeKeywordCandidates",
  "negativeProductTargetCandidates",
  "bidDownCandidates",
  "productPageCheckWarnings",
  "profitRiskWarnings"
];

const SHADOW_GUARDRAILS = {
  shadowMode: true,
  externalExecution: false,
  requiresFounderApproval: true
};

function cleanText(value: unknown): string | null {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

function normalizeIdPart(value: unknown): string {
  return cleanText(value)?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.:-]+/g, "-") ?? "unknown";
}

function isAsin(value: string | null | undefined): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(value ?? "");
}

function normalizeRisk(value: unknown): ActionLedgerRiskLevel {
  const label = String(value ?? "MEDIUM").toUpperCase();
  if (label === "VERY_HIGH" || label === "CRITICAL") return "CRITICAL";
  if (label === "HIGH" || label === "URGENT") return "HIGH";
  if (label === "LOW") return "LOW";
  return "MEDIUM";
}

function normalizeConfidence(value: unknown): ActionLedgerConfidenceLabel {
  const label = String(value ?? "MEDIUM").toUpperCase();
  if (label === "HIGH") return "HIGH";
  if (label === "LOW") return "LOW";
  return "MEDIUM";
}

function normalizeApprovalTier(value: unknown): ActionLedgerApprovalTier {
  const label = String(value ?? "TIER_2").toUpperCase();
  if (label === "FOUNDER_OVERRIDE" || label === "FOUNDER_OVERRIDE_REQUIRED") return "FOUNDER_OVERRIDE";
  if (label === "TIER_3" || label === "HIGH_RISK_APPROVAL") return "TIER_3";
  if (label === "TIER_1") return "TIER_1";
  return "TIER_2";
}

function ppcActionType(action: string | null | undefined): ActionLedgerActionType {
  const normalized = String(action ?? "").toUpperCase();
  if (normalized === "ADD_EXACT_KEYWORD_AFTER_APPROVAL") return "ADD_EXACT_KEYWORD_AFTER_APPROVAL";
  if (normalized === "ADD_PRODUCT_TARGET_AFTER_APPROVAL") return "ADD_PRODUCT_TARGET_AFTER_APPROVAL";
  if (normalized === "CHECK_LISTING_BEFORE_NEGATIVE") return "CHECK_LISTING_BEFORE_NEGATIVE";
  if (normalized === "LOWER_BID_AFTER_APPROVAL" || normalized === "ADD_NEGATIVE_AFTER_APPROVAL") return "PAUSE_OR_REDUCE_SPEND_AFTER_APPROVAL";
  return "PPC_GUARDRAIL_REVIEW";
}

function ppcEntityType(action: string | null | undefined, entityValue: string | null, asin: string | null): ActionLedgerEntityType {
  const normalized = String(action ?? "").toUpperCase();
  if (normalized === "ADD_PRODUCT_TARGET_AFTER_APPROVAL" || asin || isAsin(entityValue)) return "ASIN";
  if (normalized.includes("KEYWORD") || entityValue) return "KEYWORD";
  return "CAMPAIGN";
}

function ppcSourceId(input: {
  campaignId?: string | null;
  adGroupId?: string | null;
  keywordText?: string | null;
  asin?: string | null;
  action: string | null;
}): string {
  const actionType = ppcActionType(input.action);
  if (actionType === "ADD_PRODUCT_TARGET_AFTER_APPROVAL") {
    return `ppc:product-target:${normalizeIdPart(input.campaignId)}:${normalizeIdPart(input.adGroupId)}:${normalizeIdPart(input.asin ?? input.keywordText)}`;
  }
  return `ppc:keyword:${normalizeIdPart(input.campaignId)}:${normalizeIdPart(input.adGroupId)}:${normalizeIdPart(input.keywordText)}:exact`;
}

function ppcTitle(input: { action: string | null; entityValue: string | null; asin: string | null }): string {
  const action = String(input.action ?? "").toUpperCase();
  const label = input.asin ?? input.entityValue ?? "recommendation";
  if (action === "ADD_EXACT_KEYWORD_AFTER_APPROVAL") return `Approve exact keyword: ${label}`;
  if (action === "ADD_PRODUCT_TARGET_AFTER_APPROVAL") return `Review product target: ${label}`;
  if (action === "CHECK_LISTING_BEFORE_NEGATIVE") return "Check listing before adding negative keyword";
  if (action === "LOWER_BID_AFTER_APPROVAL" || action === "ADD_NEGATIVE_AFTER_APPROVAL") return `Review spend reduction for ${label}`;
  return `Review PPC guardrail: ${label}`;
}

function savedRecommendationToCandidate(row: SafeAiRecommendationRow): SyncCandidate {
  const entityValue = cleanText(row.entityValue);
  const asin = cleanText(row.asin) ?? (isAsin(entityValue) ? entityValue?.toUpperCase() ?? null : null);
  const entityType = ppcEntityType(row.recommendedAction, entityValue, asin);
  const entityId = entityType === "ASIN" ? asin : entityValue ?? cleanText(row.campaignId);

  return {
    sourceName: "PPC_RECOMMENDATIONS",
    sellerId: row.sellerId,
    source: "PPC_RECOMMENDATIONS",
    sourceId: ppcSourceId({
      campaignId: row.campaignId,
      adGroupId: row.adGroupId,
      keywordText: entityValue,
      asin,
      action: row.recommendedAction
    }),
    actionType: ppcActionType(row.recommendedAction),
    entityType,
    entityId,
    sku: cleanText(row.sku),
    asin,
    title: ppcTitle({ action: row.recommendedAction, entityValue, asin }),
    summary: row.reason,
    recommendedAction: row.recommendedAction,
    expectedProfitImpact: row.expectedProfitImpact,
    riskLevel: normalizeRisk(row.riskLevel),
    confidenceLabel: normalizeConfidence(row.confidenceLabel),
    approvalTier: normalizeApprovalTier(row.approvalTier),
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      recommendationId: row.id,
      recommendationType: row.recommendationType,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      adGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      source: row.source,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      recommendationEvidence: row.evidence,
      profitEvidence: row.profitEvidence
    },
    guardrails: SHADOW_GUARDRAILS
  };
}

function generatedPpcRecommendationToCandidate(sellerId: string, item: RecommendationItem): SyncCandidate {
  const asin = isAsin(item.searchTerm) ? item.searchTerm.toUpperCase() : null;
  const entityType = ppcEntityType(item.recommendedAction, item.searchTerm, asin);
  return {
    sourceName: "PPC_RECOMMENDATIONS",
    sellerId,
    source: "PPC_RECOMMENDATIONS",
    sourceId: ppcSourceId({
      campaignId: item.campaignId,
      adGroupId: item.adGroupId,
      keywordText: item.searchTerm,
      asin,
      action: item.recommendedAction
    }),
    actionType: ppcActionType(item.recommendedAction),
    entityType,
    entityId: entityType === "ASIN" ? asin : item.searchTerm,
    sku: null,
    asin,
    title: ppcTitle({ action: item.recommendedAction, entityValue: item.searchTerm, asin }),
    summary: item.reason,
    recommendedAction: item.recommendedAction,
    expectedProfitImpact: null,
    riskLevel: normalizeRisk(item.riskLevel),
    confidenceLabel: normalizeConfidence(item.confidenceLabel),
    approvalTier: normalizeApprovalTier(item.approvalTier),
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      recommendationType: item.recommendationType,
      campaignId: item.campaignId,
      campaignName: item.campaignName,
      adGroupId: item.adGroupId,
      adGroupName: item.adGroupName,
      ruleVersion: item.ruleVersion,
      strategyVersion: item.strategyVersion,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      recommendationEvidence: item.evidence,
      profitEvidence: item.profitEvidence,
      dataMaturity: item.dataMaturity
    },
    guardrails: SHADOW_GUARDRAILS
  };
}

function productEconomicsProfitBandCandidate(row: SafeProductEconomicsRow): SyncCandidate | null {
  const band = row.recommendedProfitBand ?? row.approval?.requestedProfitBand ?? null;
  if (!band) return null;
  const sku = cleanText(row.sku);
  const bandLabel = cleanText(band.bandLabel) ?? "profit-band";
  return {
    sourceName: "PRODUCT_ECONOMICS",
    sellerId: row.sellerId,
    source: "PRODUCT_ECONOMICS",
    sourceId: `product-economics:${normalizeIdPart(sku ?? row.asin)}:profit-band:${normalizeIdPart(bandLabel)}`,
    actionType: "PROFIT_BAND_APPROVAL",
    entityType: "SKU",
    entityId: sku,
    sku,
    asin: cleanText(row.asin),
    title: `Approve profit band for ${sku ?? row.productName ?? row.asin ?? "product"}`,
    summary: row.approval?.reason ?? row.recommendedProfitBandReason,
    recommendedAction: "APPROVE_PROFIT_BAND",
    expectedProfitImpact: band.minProfit,
    riskLevel: normalizeRisk(band.riskLevel),
    confidenceLabel: "MEDIUM",
    approvalTier: normalizeApprovalTier(band.approvalTier),
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      profitBand: band,
      currentRequiredProfit: row.approval?.currentRequiredProfit ?? row.requiredProfit,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      productEconomicsId: row.id,
      profitStatus: row.profitStatus,
      profitDataStatus: row.profitDataStatus,
      targetAcos: row.targetAcos,
      breakEvenAcos: row.breakEvenAcos
    },
    guardrails: SHADOW_GUARDRAILS
  };
}

function productEconomicsCostCandidate(row: CostCompletionQueueRow): SyncCandidate | null {
  if (!["MISSING_COST_DATA", "INCOMPLETE", "BLOCKED"].includes(row.costStatus)) return null;
  const sku = cleanText(row.sku);
  const asin = cleanText(row.asin);
  return {
    sourceName: "PRODUCT_ECONOMICS",
    sellerId: "default",
    source: "PRODUCT_ECONOMICS",
    sourceId: `product-economics:${normalizeIdPart(sku ?? asin)}:missing-cost-data`,
    actionType: "COST_DATA_REQUIRED",
    entityType: "SKU",
    entityId: sku ?? asin,
    sku,
    asin,
    title: `Complete product cost data for ${sku ?? row.productName ?? asin ?? "product"}`,
    summary: row.nextActionLabel,
    recommendedAction: "COMPLETE_COST_DATA",
    expectedProfitImpact: null,
    riskLevel: row.costStatus === "BLOCKED" ? "HIGH" : "MEDIUM",
    confidenceLabel: "HIGH",
    approvalTier: "TIER_2",
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      missingFields: row.missingFields,
      costStatus: row.costStatus,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      profitStatus: row.profitStatus,
      profitDataStatus: row.profitDataStatus,
      targetAcos: row.targetAcos,
      breakEvenAcos: row.breakEvenAcos
    },
    guardrails: SHADOW_GUARDRAILS
  };
}

function productEconomicsProfitRiskCandidate(row: SafeProductEconomicsRow): SyncCandidate | null {
  const hasUnsafeProfitStatus = ["BLOCKED", "FAIL", "RISK"].includes(row.profitStatus);
  const hasTargetAcosRisk = row.targetAcos !== null && (row.targetAcos <= 5 || row.targetAcos >= 80);

  if (!hasUnsafeProfitStatus && !hasTargetAcosRisk) return null;

  const sku = cleanText(row.sku);
  const asin = cleanText(row.asin);
  const riskReason = hasUnsafeProfitStatus ? row.profitStatus : "target-acos-risk";

  return {
    sourceName: "PRODUCT_ECONOMICS",
    sellerId: row.sellerId,
    source: "PRODUCT_ECONOMICS",
    sourceId: `product-economics:${normalizeIdPart(sku ?? asin)}:profit-risk:${normalizeIdPart(riskReason)}`,
    actionType: "PROFIT_RISK_REVIEW",
    entityType: "SKU",
    entityId: sku ?? asin,
    sku,
    asin,
    title: `Review profit risk for ${sku ?? row.productName ?? asin ?? "product"}`,
    summary: row.reason,
    recommendedAction: "REVIEW_PROFIT_RISK",
    expectedProfitImpact: row.netProfit,
    riskLevel: row.profitStatus === "BLOCKED" || row.profitStatus === "FAIL" ? "HIGH" : "MEDIUM",
    confidenceLabel: "MEDIUM",
    approvalTier: row.profitStatus === "BLOCKED" || row.profitStatus === "FAIL" ? "TIER_3" : "TIER_2",
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      profitStatus: row.profitStatus,
      profitDataStatus: row.profitDataStatus,
      targetAcos: row.targetAcos,
      breakEvenAcos: row.breakEvenAcos,
      maxAllowableAdSpend: row.maxAllowableAdSpend,
      requiredProfit: row.requiredProfit,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      productEconomicsId: row.id,
      sellingPrice: row.sellingPrice,
      nonAdCost: row.nonAdCost,
      netProfit: row.netProfit,
      netProfitBeforeAds: row.netProfitBeforeAds
    },
    guardrails: SHADOW_GUARDRAILS
  };
}

function ceoActionType(alertType: string, text: string): ActionLedgerActionType {
  const combined = `${alertType} ${text}`.toUpperCase();
  if (combined.includes("COST")) return "COST_DATA_REQUIRED";
  if (combined.includes("ACOS") || combined.includes("PPC") || combined.includes("APPROVAL")) return "PPC_GUARDRAIL_REVIEW";
  if (combined.includes("CANCEL") || combined.includes("RETURN") || combined.includes("ACCOUNT")) return "ACCOUNT_HEALTH_REVIEW";
  return "PROFIT_RISK_REVIEW";
}

function ceoAlertCandidate(sellerId: string, alert: Record<string, unknown>): SyncCandidate | null {
  const entityValue = cleanText(alert.entityValue ?? alert.entity_value);
  const alertType =
    cleanText(alert.type) ??
    cleanText(alert.recommendationType ?? alert.recommendation_type) ??
    cleanText(alert.recommendedAction ?? alert.recommended_action) ??
    cleanText(alert.action) ??
    cleanText(alert.title) ??
    "CEO_ALERT";
  const title = cleanText(alert.title) ?? cleanText(alert.message) ?? `Review CEO report: ${alertType}`;
  const message = cleanText(alert.message) ?? cleanText(alert.reason) ?? title;
  const sku = cleanText(alert.sku);
  const asin = cleanText(alert.asin) ?? (isAsin(entityValue) ? entityValue?.toUpperCase() ?? null : null);
  const entityId = sku ?? asin ?? entityValue ?? "account";
  const actionType = ceoActionType(alertType, `${title} ${message}`);
  return {
    sourceName: "CEO_REPORT",
    sellerId,
    source: "CEO_REPORT",
    sourceId: `ceo-report:${normalizeIdPart(sellerId)}:${normalizeIdPart(alertType)}:${normalizeIdPart(entityId)}`,
    actionType,
    entityType: sku ? "SKU" : asin ? "ASIN" : entityValue ? "KEYWORD" : "ACCOUNT",
    entityId,
    sku,
    asin,
    title,
    summary: message,
    recommendedAction: actionType,
    expectedProfitImpact: null,
    riskLevel: normalizeRisk(alert.severity ?? alert.riskLevel),
    confidenceLabel: "MEDIUM",
    approvalTier: actionType === "ACCOUNT_HEALTH_REVIEW" ? "FOUNDER_OVERRIDE" : "TIER_2",
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      alert,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      source: "ceo-report"
    },
    guardrails: SHADOW_GUARDRAILS
  };
}

async function buildPpcCandidates(sellerId: string): Promise<SyncCandidate[]> {
  const savedRecommendations = await listAiRecommendations({ sellerId, limit: 200 });
  const dateRange = getAmazonAdsPpcRecommendationDateRange(30);
  const generatedRecommendations: PpcRecommendationResponse = await getAmazonAdsPpcRecommendations({
    sellerId,
    days: 30,
    targetAcos: 35
  });
  const generatedItems = PPC_RECOMMENDATION_CATEGORIES.flatMap((category) => generatedRecommendations[category]);
  // Saved recommendations created before the maturity gate existed may rest on a handful of clicks.
  // Do not let those re-enter the approval queue (the saved row itself is left untouched).
  const matureSavedRecommendations = savedRecommendations.filter((row) => savedRecommendationAllowed(row));
  const heldBackSavedCount = savedRecommendations.length - matureSavedRecommendations.length;
  if (heldBackSavedCount > 0 || generatedRecommendations.heldBackTerms.length > 0) {
    logger.info("PPC data-maturity gate held back thin-data recommendations from the approval queue.", {
      sellerId,
      heldBackSavedCount,
      heldBackGeneratedCount: generatedRecommendations.summary.heldBackForImmatureData ?? 0
    });
  }
  return [
    ...matureSavedRecommendations.map(savedRecommendationToCandidate),
    ...generatedItems.map((item) => generatedPpcRecommendationToCandidate(sellerId, item))
  ].map((candidate) => ({
    ...candidate,
    evidence: {
      ...(candidate.evidence ?? {}),
      dataStartDate: dateRange.startDate,
      dataEndDate: dateRange.endDate
    }
  }));
}

async function buildProductEconomicsCandidates(sellerId: string): Promise<SyncCandidate[]> {
  const [economicsRows, costQueueRows] = await Promise.all([
    listProductEconomics(sellerId),
    getCostCompletionQueue(sellerId)
  ]);
  return [
    ...economicsRows.map(productEconomicsProfitBandCandidate),
    ...economicsRows.map(productEconomicsProfitRiskCandidate),
    ...costQueueRows.map((row) => {
      const candidate = productEconomicsCostCandidate(row);
      return candidate ? { ...candidate, sellerId } : null;
    })
  ].filter((candidate): candidate is SyncCandidate => Boolean(candidate));
}

async function buildCeoReportCandidates(sellerId: string): Promise<SyncCandidate[]> {
  const report = await getDailyCeoReport({ sellerId, days: 30 });
  const alerts = [
    ...(Array.isArray(report.profitRiskAlerts) ? report.profitRiskAlerts : []),
    ...(Array.isArray(report.warnings)
      ? report.warnings.map((message) => ({
          type: "CEO_WARNING",
          title: String(message),
          message: String(message)
        }))
      : [])
  ];

  return alerts
    .map((alert) => ceoAlertCandidate(sellerId, alert as Record<string, unknown>))
    .filter((candidate): candidate is SyncCandidate => Boolean(candidate));
}

async function loadCandidateGroup(
  sellerId: string,
  sourceName: SyncCandidate["sourceName"],
  loader: () => Promise<SyncCandidate[]>
): Promise<SyncCandidate[]> {
  try {
    return await loader();
  } catch (error) {
    logger.warn("Action ledger recommendation bridge source scan failed safely.", {
      sellerId,
      sourceName,
      message: error instanceof Error ? error.message : "Unknown source scan error"
    });
    return [];
  }
}

export async function syncRecommendationsToActionLedger(input: { sellerId: string }): Promise<ActionLedgerSyncResult> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const sourceNames: SyncCandidate["sourceName"][] = ["PPC_RECOMMENDATIONS", "PRODUCT_ECONOMICS", "CEO_REPORT"];
  const candidateGroups = await Promise.all([
    loadCandidateGroup(sellerId, "PPC_RECOMMENDATIONS", () => buildPpcCandidates(sellerId)),
    loadCandidateGroup(sellerId, "PRODUCT_ECONOMICS", () => buildProductEconomicsCandidates(sellerId)),
    loadCandidateGroup(sellerId, "CEO_REPORT", () => buildCeoReportCandidates(sellerId))
  ]);
  const candidates = candidateGroups.flat();
  const rows: SafeActionLedgerRow[] = [];
  let createdCount = 0;
  let existingCount = 0;
  const sourceCounts = new Map<string, { scanned: number; created: number; existing: number }>(
    sourceNames.map((sourceName) => [sourceName, { scanned: 0, created: 0, existing: 0 }])
  );

  for (const candidate of candidates) {
    const current = sourceCounts.get(candidate.sourceName) ?? { scanned: 0, created: 0, existing: 0 };
    current.scanned += 1;
    const result = await ensureActionLedgerAction(candidate);
    rows.push(result.row);

    if (result.created) {
      createdCount += 1;
      current.created += 1;
    } else {
      existingCount += 1;
      current.existing += 1;
    }

    sourceCounts.set(candidate.sourceName, current);
  }

  for (const [sourceName, counts] of sourceCounts.entries()) {
    logger.info("Action ledger recommendation bridge sync completed for source.", {
      sellerId,
      sourceName,
      scannedCount: counts.scanned,
      createdCount: counts.created,
      skippedDuplicateCount: counts.existing
    });
  }

  logger.info("Action ledger recommendation bridge sync completed.", {
    sellerId,
    scannedCount: candidates.length,
    createdCount,
    skippedDuplicateCount: existingCount
  });

  return {
    ok: true,
    sellerId,
    createdCount,
    existingCount,
    totalScanned: candidates.length,
    rows
  };
}
