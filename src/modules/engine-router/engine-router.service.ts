import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import { getAmazonAdsPpcRecommendations, RecommendationItem } from "../amazon-ads/amazon-ads-ppc-recommendation.service";
import { getListingReadinessByProductPassportId, getListingReadinessSummary } from "../listing-readiness/listing-readiness.service";
import { getAplusContentCoverage } from "../aplus-content/aplus-content.service";
import {
  ActionLedgerActionType,
  ActionLedgerApprovalTier,
  ActionLedgerEntityType,
  ActionLedgerRiskLevel,
  SafeActionLedgerRow
} from "../action-ledger/action-ledger.types";
import { recordWorkflowEvent } from "../action-ledger/action-workflow.service";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { getDailyCeoReport } from "../ceo-report/ceo-report.service";
import { EngineRegistryRow, EngineRunLogRow, SafeEngineRegistryRow, SafeEngineRunLogRow } from "../engine-registry/engine-registry.types";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { getCostCompletionQueue, listProductEconomics } from "../product-economics/product-economics.service";
import { CostCompletionQueueRow, SafeProductEconomicsRow } from "../product-economics/product-economics.types";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import { AmazonSpListingRow, AmazonSpOrderItemRow, AmazonSpOrderRow } from "../amazon-sp/amazon-sp.types";
import {
  EnginePreviewDecision,
  EngineRouterActionDraft,
  EngineRouterRunPreviewInput,
  EngineRouterSummary,
  EngineRunResult,
  EngineRunStatus
} from "./engine-router.types";
import { LearningEventType } from "../learning-loop/learning-loop.types";

type EngineRunLogInsert = {
  engine_key: string;
  seller_id: string;
  run_status: EngineRunStatus;
  run_type: "PREVIEW_ONLY";
  input_snapshot: Record<string, unknown>;
  output_snapshot: Record<string, unknown>;
  actions_created_count: number;
  error_message?: string | null;
  finished_at: string;
  metadata: Record<string, unknown>;
};

type CeoReportShape = {
  ppcSnapshot?: {
    cost?: number;
    sales?: number;
    acos?: number | null;
  };
  profitGuardrail?: {
    targetAcos?: number | null;
    effectiveTargetAcos?: number | null;
    profitDataStatus?: string;
    reason?: string;
  };
  amazonSalesSummary?: {
    rawSales?: number;
    cancelledSales?: number;
    cancelledOrders?: number;
  };
  profitRiskAlerts?: Array<Record<string, unknown>>;
};

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

function logEngineRouterError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSafeEngine(row: EngineRegistryRow): SafeEngineRegistryRow {
  return {
    id: row.id,
    engineKey: row.engine_key,
    engineName: row.engine_name,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    inputRequirements: asArray(row.input_requirements),
    dataSources: asArray(row.data_sources),
    ruleTemplate: row.rule_template,
    ruleConfig: toJsonObject(row.rule_config),
    outputActionType: row.output_action_type,
    outputEntityType: row.output_entity_type,
    riskLevel: row.risk_level,
    costLevel: row.cost_level,
    priorityScore: toNumber(row.priority_score),
    runFrequency: row.run_frequency,
    enabled: Boolean(row.enabled),
    shadowMode: Boolean(row.shadow_mode),
    requiresApproval: Boolean(row.requires_approval),
    ownerModule: row.owner_module,
    version: row.version,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunSummary: row.last_run_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeRunLog(row: EngineRunLogRow): SafeEngineRunLogRow {
  return {
    id: row.id,
    engineKey: row.engine_key,
    sellerId: row.seller_id,
    runStatus: row.run_status,
    runType: row.run_type,
    inputSnapshot: row.input_snapshot,
    outputSnapshot: row.output_snapshot,
    actionsCreatedCount: row.actions_created_count,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    metadata: toJsonObject(row.metadata)
  };
}

function riskWeight(riskLevel: string): number {
  if (riskLevel === "HIGH" || riskLevel === "CRITICAL") return 3;
  if (riskLevel === "MEDIUM") return 2;
  if (riskLevel === "LOW") return 1;
  return 0;
}

function lastRunWeight(lastRunAt: string | null): number {
  return lastRunAt ? Date.parse(lastRunAt) || 0 : -1;
}

function sortRunnableEngines(rows: SafeEngineRegistryRow[]): SafeEngineRegistryRow[] {
  return [...rows].sort((a, b) => {
    const priorityDiff = b.priorityScore - a.priorityScore;
    if (priorityDiff) return priorityDiff;

    const riskDiff = riskWeight(b.riskLevel) - riskWeight(a.riskLevel);
    if (riskDiff) return riskDiff;

    return lastRunWeight(a.lastRunAt) - lastRunWeight(b.lastRunAt);
  });
}

async function loadRunnableEngines(input: {
  limit: number;
  categories?: string[];
}): Promise<SafeEngineRegistryRow[]> {
  let query = supabase
    .from("engine_registry")
    .select("*")
    .eq("enabled", true)
    .eq("shadow_mode", true)
    .eq("requires_approval", true)
    .limit(1000);

  if (input.categories?.length) {
    query = query.in("category", input.categories);
  }

  const { data, error } = await query;

  if (error) {
    logEngineRouterError("Could not load runnable engines.", error);
    throw new Error("Could not load runnable engines from Supabase.");
  }

  return sortRunnableEngines(((data ?? []) as EngineRegistryRow[]).map(toSafeEngine)).slice(0, input.limit);
}

async function getEngineByKey(engineKeyInput: string): Promise<SafeEngineRegistryRow | null> {
  const engineKey = cleanText(engineKeyInput);
  if (!engineKey) return null;

  const { data, error } = await supabase
    .from("engine_registry")
    .select("*")
    .eq("engine_key", engineKey)
    .maybeSingle<EngineRegistryRow>();

  if (error) {
    logEngineRouterError("Could not load engine by key.", error);
    throw new Error("Could not load engine registry row from Supabase.");
  }

  if (!data || !data.enabled || !data.shadow_mode || !data.requires_approval) {
    return null;
  }

  return toSafeEngine(data);
}

function entityKey(input: {
  sku?: string | null;
  asin?: string | null;
  entityId?: string | null;
  fallback?: string | null;
}): string {
  return cleanText(input.sku) ?? cleanText(input.asin) ?? cleanText(input.entityId) ?? cleanText(input.fallback) ?? "account";
}

function sourceIdFor(engine: SafeEngineRegistryRow, draft: EngineRouterActionDraft): string {
  return `${engine.engineKey}:${entityKey({
    sku: draft.sku,
    asin: draft.asin,
    entityId: draft.entityId,
    fallback: draft.entityType
  })}`;
}

async function pendingDuplicateExists(input: {
  sellerId: string;
  engine: SafeEngineRegistryRow;
  draft: EngineRouterActionDraft;
}): Promise<boolean> {
  const { count, error } = await supabase
    .from("action_ledger")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId)
    .eq("source", "ENGINE_ROUTER")
    .eq("source_id", sourceIdFor(input.engine, input.draft))
    .eq("action_type", input.draft.actionType)
    .eq("approval_status", "PENDING");

  if (error) {
    logEngineRouterError("Could not check engine router duplicate action.", error);
    throw new Error("Could not check engine router duplicate action in Supabase.");
  }

  return (count ?? 0) > 0;
}

async function recordCreationWorkflowEvent(action: SafeActionLedgerRow, actor: string): Promise<void> {
  await recordWorkflowEvent({
    actionId: action.id,
    sellerId: action.sellerId,
    fromState: null,
    toState: "WAITING_FOR_APPROVAL",
    eventType: "ENGINE_RECOMMENDATION_CREATED",
    actor: "system",
    note: `Engine Router created preview recommendation${actor ? ` for ${actor}` : ""}.`,
    snapshotAfter: action,
    metadata: {
      engineRouter: true,
      previewOnly: true
    }
  }).catch((error) => {
    logger.warn("Could not record workflow event for engine recommendation.", {
      actionId: action.id,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown workflow error")
    });
  });
}

async function createActionIfUseful(input: {
  sellerId: string;
  actor: string;
  engine: SafeEngineRegistryRow;
  decision: EnginePreviewDecision;
}): Promise<{ action: SafeActionLedgerRow | null; actionCreated: boolean; duplicateSkipped: boolean }> {
  const draft = input.decision.actionDraft;
  if (!draft) {
    return { action: null, actionCreated: false, duplicateSkipped: false };
  }

  const duplicateSkipped = await pendingDuplicateExists({
    sellerId: input.sellerId,
    engine: input.engine,
    draft
  });

  if (duplicateSkipped) {
    return { action: null, actionCreated: false, duplicateSkipped: true };
  }

  const row = await ensureActionLedgerAction({
    sellerId: input.sellerId,
    source: "ENGINE_ROUTER",
    sourceId: sourceIdFor(input.engine, draft),
    actionType: draft.actionType as ActionLedgerActionType,
    entityType: draft.entityType as ActionLedgerEntityType | null,
    entityId: draft.entityId,
    sku: draft.sku,
    asin: draft.asin,
    title: draft.title,
    summary: draft.summary,
    recommendedAction: draft.recommendedAction,
    expectedProfitImpact: draft.expectedProfitImpact ?? null,
    expectedSalesImpact: draft.expectedSalesImpact ?? null,
    expectedBrandImpact: draft.expectedBrandImpact ?? null,
    riskLevel: draft.riskLevel as ActionLedgerRiskLevel,
    confidenceLabel: draft.confidenceLabel,
    approvalTier: draft.approvalTier as ActionLedgerApprovalTier,
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      engineKey: input.engine.engineKey,
      ruleTemplate: input.engine.ruleTemplate,
      engineCategory: input.engine.category,
      previewOnly: true,
      actor: input.actor
    },
    evidence: draft.evidence,
    guardrails: {
      shadowMode: true,
      externalExecution: false,
      requiresApproval: true,
      amazonUpdate: false,
      adsUpdate: false,
      aiCall: false
    }
  });

  await recordCreationWorkflowEvent(row.row, input.actor);

  return {
    action: row.row,
    actionCreated: row.created,
    duplicateSkipped: !row.created
  };
}

function isMissingCostQueueRow(row: CostCompletionQueueRow): boolean {
  return row.costStatus !== "COMPLETE" || row.missingFields.length > 0;
}

async function runMissingDataCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const queue = await getCostCompletionQueue(sellerId);
  const row = queue.find(isMissingCostQueueRow);

  if (!queue.length || !row) {
    return {
      status: queue.length ? "PREVIEW_NO_ACTION" : "SKIPPED_NO_DATA",
      summary: queue.length ? "No missing cost completion rows found." : "No product passport, listing, or product economics data found.",
      evidence: { queueCount: queue.length }
    };
  }

  const sku = cleanText(row.sku);
  const asin = cleanText(row.asin);
  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Missing cost/readiness data found for ${sku ?? asin ?? row.productName ?? "product"}.`,
    actionDraft: {
      actionType: "COST_DATA_REQUIRED",
      entityType: sku ? "SKU" : asin ? "ASIN" : "ACCOUNT",
      entityId: sku ?? asin ?? "cost-completion",
      sku,
      asin,
      title: `Complete cost data for ${sku ?? row.productName ?? asin ?? "product"}`,
      summary: `Missing fields: ${row.missingFields.join(", ") || row.nextActionLabel}.`,
      recommendedAction: "COMPLETE_COST_DATA",
      riskLevel: "MEDIUM",
      confidenceLabel: "HIGH",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        costStatus: row.costStatus,
        profitStatus: row.profitStatus,
        profitDataStatus: row.profitDataStatus,
        missingFields: row.missingFields,
        targetAcos: row.targetAcos,
        breakEvenAcos: row.breakEvenAcos,
        nextActionLabel: row.nextActionLabel
      }
    }
  };
}

function isUnsafeProductEconomics(row: SafeProductEconomicsRow): boolean {
  return (
    ["BLOCKED", "NEEDS_INPUT", "NEEDS_COST_DATA", "FAIL", "RISK"].includes(row.profitStatus) ||
    row.profitDataStatus !== "AVAILABLE" ||
    (row.targetAcos !== null && row.targetAcos <= 5)
  );
}

async function runProfitGuardrailCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const rows = await listProductEconomics(sellerId);
  const row = rows.find(isUnsafeProductEconomics);

  if (!rows.length || !row) {
    return {
      status: rows.length ? "PREVIEW_NO_ACTION" : "SKIPPED_NO_DATA",
      summary: rows.length ? "No unsafe product economics rows found." : "No product economics data found.",
      evidence: { economicsRows: rows.length }
    };
  }

  const highRisk = row.profitStatus === "BLOCKED" || row.profitStatus === "FAIL" || row.targetAcos === null || row.targetAcos <= 0;
  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Profit guardrail risk found for ${row.sku ?? row.asin ?? row.productName ?? "product"}.`,
    actionDraft: {
      actionType: "PROFIT_RISK_REVIEW",
      entityType: row.sku ? "SKU" : row.asin ? "ASIN" : "ACCOUNT",
      entityId: row.sku ?? row.asin ?? "profit-risk",
      sku: row.sku,
      asin: row.asin,
      title: `Review profit risk for ${row.sku ?? row.productName ?? row.asin ?? "product"}`,
      summary: row.reason,
      recommendedAction: "REVIEW_PROFIT_RISK",
      expectedProfitImpact: row.netProfit,
      riskLevel: highRisk ? "HIGH" : "MEDIUM",
      confidenceLabel: "HIGH",
      approvalTier: highRisk ? "TIER_3" : "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        productEconomicsId: row.id,
        profitStatus: row.profitStatus,
        profitDataStatus: row.profitDataStatus,
        targetAcos: row.targetAcos,
        breakEvenAcos: row.breakEvenAcos,
        maxAllowableAdSpend: row.maxAllowableAdSpend,
        nonAdCost: row.nonAdCost,
        netProfit: row.netProfit
      }
    }
  };
}

async function runAcosGuardrailCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const report = (await getDailyCeoReport({ sellerId, days: 14 })) as CeoReportShape;
  const ppcSnapshot = report.ppcSnapshot;
  const targetAcos = toNumber(report.profitGuardrail?.effectiveTargetAcos ?? report.profitGuardrail?.targetAcos);
  const acos = ppcSnapshot?.acos ?? null;

  if (!ppcSnapshot || ppcSnapshot.cost === undefined) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No local PPC summary data found.",
      evidence: { reportLoaded: Boolean(report) }
    };
  }

  if (acos === null || targetAcos <= 0 || acos <= targetAcos) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "PPC ACOS is not above target guardrail.",
      evidence: { acos, targetAcos, cost: ppcSnapshot.cost, sales: ppcSnapshot.sales }
    };
  }

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `PPC ACOS ${acos}% is above target ${targetAcos}%.`,
    actionDraft: {
      actionType: "PPC_GUARDRAIL_REVIEW",
      entityType: "ACCOUNT",
      entityId: "ppc-account",
      sku: null,
      asin: null,
      title: "Review PPC spend guardrail",
      summary: `Overall PPC ACOS is ${acos}%, above target ${targetAcos}%.`,
      recommendedAction: "REVIEW_PPC_SPEND",
      expectedSalesImpact: toNumber(ppcSnapshot.sales),
      riskLevel: "HIGH",
      confidenceLabel: "MEDIUM",
      approvalTier: "TIER_3",
      evidence: {
        engineKey: engine.engineKey,
        acos,
        targetAcos,
        cost: ppcSnapshot.cost,
        sales: ppcSnapshot.sales,
        profitGuardrail: report.profitGuardrail ?? null
      }
    }
  };
}

function passportMissingListingReadiness(row: ProductPassportRow): string[] {
  const missing: string[] = [];
  if (!cleanText(row.product_name)) missing.push("product_name");
  if (!cleanText(row.category) && !cleanText(row.product_type)) missing.push("category_or_product_type");
  if (!asArray(row.key_features).length) missing.push("key_features");
  if (!asArray(row.image_urls).length) missing.push("image_urls");
  if (!asArray(row.seo_keywords).length) missing.push("seo_keywords");
  if (!cleanText(row.package_contents)) missing.push("package_contents");
  return missing;
}

async function runListingReadinessCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const { data, error } = await supabase
    .from("product_passports")
    .select("*")
    .eq("seller_id", sellerId)
    .neq("status", "ARCHIVED")
    .limit(200);

  if (error) {
    logEngineRouterError("Could not load product passports for listing readiness engine.", error);
    throw new Error("Could not load product passports from Supabase.");
  }

  const rows = (data ?? []) as ProductPassportRow[];
  const row = rows.find((item) => passportMissingListingReadiness(item).length > 0);

  if (!rows.length || !row) {
    return {
      status: rows.length ? "PREVIEW_NO_ACTION" : "SKIPPED_NO_DATA",
      summary: rows.length ? "No listing readiness gaps found in product passports." : "No product passports found.",
      evidence: { productPassportCount: rows.length }
    };
  }

  const missingFields = passportMissingListingReadiness(row);
  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Listing readiness gaps found for ${row.sku ?? row.asin ?? row.product_name}.`,
    actionDraft: {
      actionType: "LISTING_READINESS_REVIEW",
      entityType: row.asin ? "ASIN" : row.sku ? "SKU" : "ACCOUNT",
      entityId: row.asin ?? row.sku ?? row.id,
      sku: row.sku,
      asin: row.asin,
      title: `Complete listing readiness for ${row.sku ?? row.product_name ?? row.asin ?? "product"}`,
      summary: `Missing listing inputs: ${missingFields.join(", ")}.`,
      recommendedAction: "COMPLETE_LISTING_READINESS",
      riskLevel: "MEDIUM",
      confidenceLabel: "MEDIUM",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        productPassportId: row.id,
        productName: row.product_name,
        missingFields
      }
    }
  };
}

async function runAccountHealthCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const report = (await getDailyCeoReport({ sellerId, days: 14 })) as CeoReportShape;
  const salesSummary = report.amazonSalesSummary;
  const rawSales = toNumber(salesSummary?.rawSales);
  const cancelledSales = toNumber(salesSummary?.cancelledSales);
  const cancelledShare = rawSales > 0 ? (cancelledSales / rawSales) * 100 : 0;
  const healthAlerts = (report.profitRiskAlerts ?? []).filter((alert) => String(alert.type ?? "").includes("CANCELLED"));

  if (!salesSummary) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No local account/order summary data found.",
      evidence: { reportLoaded: Boolean(report) }
    };
  }

  if (cancelledShare < 30 && healthAlerts.length === 0) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No account health order risk detected.",
      evidence: { rawSales, cancelledSales, cancelledShare }
    };
  }

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Account health review needed: cancelled sales share is ${Math.round(cancelledShare * 100) / 100}%.`,
    actionDraft: {
      actionType: "ACCOUNT_HEALTH_REVIEW",
      entityType: "ACCOUNT",
      entityId: "account-health",
      sku: null,
      asin: null,
      title: "Review account health and cancelled order risk",
      summary: `Cancelled sales are ${Math.round(cancelledShare * 100) / 100}% of raw sales.`,
      recommendedAction: "ACCOUNT_HEALTH_REVIEW",
      riskLevel: "HIGH",
      confidenceLabel: "MEDIUM",
      approvalTier: "TIER_3",
      evidence: {
        engineKey: engine.engineKey,
        rawSales,
        cancelledSales,
        cancelledOrders: salesSummary.cancelledOrders ?? 0,
        cancelledShare,
        alerts: healthAlerts
      }
    }
  };
}

async function resolveEffectiveTargetAcos(sellerId: string): Promise<number> {
  const report = (await getDailyCeoReport({ sellerId, days: 14 })) as CeoReportShape;
  const targetAcos = toNumber(report.profitGuardrail?.effectiveTargetAcos ?? report.profitGuardrail?.targetAcos);
  // 25% is a conservative fallback ceiling only used when no profit-guardrail target exists yet;
  // getAmazonAdsPpcRecommendations further caps this against real cost data internally.
  return targetAcos > 0 ? targetAcos : 25;
}

function isLikelyAsin(term: string): boolean {
  return /^B0[A-Z0-9]{8}$/.test(term.trim().toUpperCase());
}

function ppcOpportunityActionDraft(input: {
  item: RecommendationItem;
  actionType: string;
  entityType: "KEYWORD" | "ASIN" | "SEARCH_TERM";
  titlePrefix: string;
}): EngineRouterActionDraft {
  const { item, actionType, entityType, titlePrefix } = input;
  return {
    actionType,
    entityType,
    entityId: `${item.campaignId}:${item.adGroupId}:${item.searchTerm}`,
    sku: null,
    asin: entityType === "ASIN" ? item.searchTerm.toUpperCase() : null,
    title: `${titlePrefix} "${item.searchTerm}"`,
    summary: item.reason,
    recommendedAction: item.recommendedAction,
    expectedSalesImpact: item.evidence.sales,
    riskLevel: item.riskLevel,
    confidenceLabel: item.confidenceLabel,
    approvalTier: item.approvalTier,
    evidence: {
      campaignId: item.campaignId,
      campaignName: item.campaignName,
      adGroupId: item.adGroupId,
      adGroupName: item.adGroupName,
      searchTerm: item.searchTerm,
      performance: item.evidence,
      profitEvidence: item.profitEvidence,
      priorityScore: item.priorityScore,
      confidenceScore: item.confidenceScore,
      recommendationType: item.recommendationType
    }
  };
}

async function runKeywordOpportunityCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const lookbackDays = toNumber(engine.ruleConfig?.lookbackDays) || 14;
  const targetAcos = await resolveEffectiveTargetAcos(sellerId);
  const recommendations = await getAmazonAdsPpcRecommendations({ sellerId, days: lookbackDays, targetAcos });

  if (!recommendations.summary.totalGroupedTerms) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No PPC search term data found for the lookback window.",
      evidence: { engineKey: engine.engineKey, lookbackDays }
    };
  }

  const item = recommendations.exactMatchOpportunities[0];
  if (!item) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No exact-match keyword opportunities found.",
      evidence: {
        engineKey: engine.engineKey,
        totalGroupedTerms: recommendations.summary.totalGroupedTerms,
        effectiveTargetAcos: recommendations.effectiveTargetAcos
      }
    };
  }

  const draft = ppcOpportunityActionDraft({
    item,
    actionType: "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
    entityType: "KEYWORD",
    titlePrefix: "Add exact-match keyword"
  });
  draft.evidence.engineKey = engine.engineKey;
  draft.evidence.effectiveTargetAcos = recommendations.effectiveTargetAcos;

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Exact-match keyword opportunity found: "${item.searchTerm}".`,
    actionDraft: draft
  };
}

async function runRoasOpportunityCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const lookbackDays = toNumber(engine.ruleConfig?.lookbackDays) || 14;
  const targetAcos = await resolveEffectiveTargetAcos(sellerId);
  const recommendations = await getAmazonAdsPpcRecommendations({ sellerId, days: lookbackDays, targetAcos });

  if (!recommendations.summary.totalGroupedTerms) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No PPC search term data found for the lookback window.",
      evidence: { engineKey: engine.engineKey, lookbackDays }
    };
  }

  const item = recommendations.productTargetingOpportunities[0];
  if (!item) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No product-targeting (ROAS) opportunities found.",
      evidence: {
        engineKey: engine.engineKey,
        totalGroupedTerms: recommendations.summary.totalGroupedTerms,
        effectiveTargetAcos: recommendations.effectiveTargetAcos
      }
    };
  }

  const draft = ppcOpportunityActionDraft({
    item,
    actionType: "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
    entityType: isLikelyAsin(item.searchTerm) ? "ASIN" : "SEARCH_TERM",
    titlePrefix: "Add product-targeting opportunity"
  });
  draft.evidence.engineKey = engine.engineKey;
  draft.evidence.effectiveTargetAcos = recommendations.effectiveTargetAcos;

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Product-targeting (ROAS) opportunity found: "${item.searchTerm}".`,
    actionDraft: draft
  };
}

async function runNegativeKeywordReview(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const lookbackDays = toNumber(engine.ruleConfig?.lookbackDays) || 14;
  const targetAcos = await resolveEffectiveTargetAcos(sellerId);
  const recommendations = await getAmazonAdsPpcRecommendations({ sellerId, days: lookbackDays, targetAcos });

  if (!recommendations.summary.totalGroupedTerms) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No PPC search term data found for the lookback window.",
      evidence: { engineKey: engine.engineKey, lookbackDays }
    };
  }

  // CHECK_LISTING_BEFORE_NEGATIVE is deliberately routed through a listing check first, per the
  // blueprint's PPC guardrail "no broad-match scaling without search-term evidence" rule -
  // this engine never proposes negating a term outright, only flags it for review.
  const sourceCategory = recommendations.productPageCheckWarnings.length ? "productPageCheckWarnings" : "negativeKeywordCandidates";
  const item = recommendations.productPageCheckWarnings[0] ?? recommendations.negativeKeywordCandidates[0];

  if (!item) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No wasteful search terms found that need a listing check before negation.",
      evidence: {
        engineKey: engine.engineKey,
        totalGroupedTerms: recommendations.summary.totalGroupedTerms,
        effectiveTargetAcos: recommendations.effectiveTargetAcos
      }
    };
  }

  const draft = ppcOpportunityActionDraft({
    item,
    actionType: "CHECK_LISTING_BEFORE_NEGATIVE",
    entityType: "SEARCH_TERM",
    titlePrefix: "Check listing before negating"
  });
  draft.evidence.engineKey = engine.engineKey;
  draft.evidence.effectiveTargetAcos = recommendations.effectiveTargetAcos;
  draft.evidence.sourceCategory = sourceCategory;

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Wasteful search term "${item.searchTerm}" needs a listing check before any negative-keyword action.`,
    actionDraft: draft
  };
}

function isThinMarginRow(row: SafeProductEconomicsRow): boolean {
  return row.profitDataStatus === "AVAILABLE" && row.profitMarginPercent !== null && row.profitMarginPercent < 8;
}

async function runPricingRiskCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const rows = await listProductEconomics(sellerId);
  const priced = rows.filter((row) => row.profitDataStatus === "AVAILABLE" && row.profitMarginPercent !== null);

  if (!priced.length) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No product economics rows with a confirmed margin found.",
      evidence: { engineKey: engine.engineKey, economicsRows: rows.length }
    };
  }

  const row = priced.filter(isThinMarginRow).sort((a, b) => (a.profitMarginPercent ?? 0) - (b.profitMarginPercent ?? 0))[0];

  if (!row) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No thin-margin pricing risk found.",
      evidence: { engineKey: engine.engineKey, pricedRows: priced.length }
    };
  }

  const highRisk = row.profitMarginPercent !== null && row.profitMarginPercent <= 0;
  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Pricing margin risk found for ${row.sku ?? row.asin ?? row.productName ?? "product"}.`,
    actionDraft: {
      actionType: "PRICING_REVIEW",
      entityType: row.sku ? "SKU" : row.asin ? "ASIN" : "ACCOUNT",
      entityId: row.sku ?? row.asin ?? "pricing-risk",
      sku: row.sku,
      asin: row.asin,
      title: `Review pricing/margin for ${row.sku ?? row.productName ?? row.asin ?? "product"}`,
      summary: `Profit margin is ${row.profitMarginPercent}% at a selling price of ${row.sellingPrice}.`,
      recommendedAction: "REVIEW_PRICING_MARGIN",
      expectedProfitImpact: row.netProfit,
      riskLevel: highRisk ? "HIGH" : "MEDIUM",
      confidenceLabel: "HIGH",
      approvalTier: highRisk ? "TIER_3" : "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        productEconomicsId: row.id,
        sellingPrice: row.sellingPrice,
        landedCost: row.landedCost,
        netProfit: row.netProfit,
        profitMarginPercent: row.profitMarginPercent,
        minimumApprovedProfit: row.minimumApprovedProfit
      }
    }
  };
}

const SEO_GAP_ITEMS = new Set([
  "at_least_5_seo_keywords",
  "at_least_10_seo_keywords",
  "category",
  "product_type",
  "use_case",
  "target_customer"
]);

const CONVERSION_GAP_ITEMS = new Set([
  "material",
  "dimensions",
  "weight",
  "package_contents",
  "at_least_2_customer_objections",
  "compliance_notes",
  "at_least_3_key_features",
  "at_least_5_key_features"
]);

async function runListingSeoGapCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const summary = await getListingReadinessSummary(sellerId);

  if (!summary.rows.length) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No product passports found for listing SEO review.",
      evidence: { engineKey: engine.engineKey, productCount: 0 }
    };
  }

  const candidate = summary.rows.find(
    (row) => row.readinessStatus !== "READY" && row.topMissingItems.some((item) => SEO_GAP_ITEMS.has(item))
  );

  if (!candidate) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No listing SEO gaps found.",
      evidence: { engineKey: engine.engineKey, productCount: summary.rows.length }
    };
  }

  const detail = await getListingReadinessByProductPassportId(candidate.productPassportId);
  const seoSection = detail?.sections.seoReadiness;

  if (!seoSection || seoSection.score >= 60) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No listing SEO gaps confirmed after detail review.",
      evidence: { engineKey: engine.engineKey, productPassportId: candidate.productPassportId, seoScore: seoSection?.score ?? null }
    };
  }

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `SEO keyword gaps found for ${candidate.sku ?? candidate.asin ?? candidate.productName}.`,
    actionDraft: {
      actionType: "LISTING_SEO_REVIEW",
      entityType: candidate.asin ? "ASIN" : candidate.sku ? "SKU" : "ACCOUNT",
      entityId: candidate.asin ?? candidate.sku ?? candidate.productPassportId,
      sku: candidate.sku,
      asin: candidate.asin,
      title: `Fix SEO keyword gaps for ${candidate.sku ?? candidate.productName ?? candidate.asin ?? "product"}`,
      summary: `SEO readiness score is ${seoSection.score}/100. Missing: ${seoSection.missingItems.join(", ")}.`,
      recommendedAction: "IMPROVE_LISTING_SEO",
      riskLevel: seoSection.score < 30 ? "HIGH" : "MEDIUM",
      confidenceLabel: "HIGH",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        productPassportId: candidate.productPassportId,
        seoScore: seoSection.score,
        missingItems: seoSection.missingItems,
        overallScore: candidate.overallScore
      }
    }
  };
}

async function runConversionRiskCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const summary = await getListingReadinessSummary(sellerId);

  if (!summary.rows.length) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No product passports found for conversion risk review.",
      evidence: { engineKey: engine.engineKey, productCount: 0 }
    };
  }

  const candidate = summary.rows.find(
    (row) => row.readinessStatus !== "READY" && row.topMissingItems.some((item) => CONVERSION_GAP_ITEMS.has(item))
  );

  if (!candidate) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No conversion risk gaps found.",
      evidence: { engineKey: engine.engineKey, productCount: summary.rows.length }
    };
  }

  const detail = await getListingReadinessByProductPassportId(candidate.productPassportId);
  const trustSection = detail?.sections.trustReadiness;
  const bulletSection = detail?.sections.bulletReadiness;
  const worstScore = Math.min(trustSection?.score ?? 100, bulletSection?.score ?? 100);

  if (!trustSection || !bulletSection || worstScore >= 60) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No conversion risk confirmed after detail review.",
      evidence: { engineKey: engine.engineKey, productPassportId: candidate.productPassportId, worstScore }
    };
  }

  const missingItems = Array.from(new Set([...trustSection.missingItems, ...bulletSection.missingItems]));

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Conversion risk found for ${candidate.sku ?? candidate.asin ?? candidate.productName}.`,
    actionDraft: {
      actionType: "LISTING_CONVERSION_REVIEW",
      entityType: candidate.asin ? "ASIN" : candidate.sku ? "SKU" : "ACCOUNT",
      entityId: candidate.asin ?? candidate.sku ?? candidate.productPassportId,
      sku: candidate.sku,
      asin: candidate.asin,
      title: `Fix trust/conversion gaps for ${candidate.sku ?? candidate.productName ?? candidate.asin ?? "product"}`,
      summary: `Trust score ${trustSection.score}/100, bullet score ${bulletSection.score}/100. Missing: ${missingItems.join(", ")}.`,
      recommendedAction: "IMPROVE_LISTING_CONVERSION",
      riskLevel: worstScore < 30 ? "HIGH" : "MEDIUM",
      confidenceLabel: "MEDIUM",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        productPassportId: candidate.productPassportId,
        trustScore: trustSection.score,
        bulletScore: bulletSection.score,
        missingItems,
        overallScore: candidate.overallScore
      }
    }
  };
}

const IMAGE_GAP_ITEMS = new Set([
  "at_least_1_image_url",
  "at_least_3_image_urls",
  "at_least_5_image_urls",
  "dimensions_or_package_contents",
  "material"
]);

// IMAGE_CREATIVE (15 engines): reuses the same real listing-readiness image scoring
// (product_passports.image_urls, already synced from real Amazon/founder catalog data)
// that Listing SEO/Conversion already use. No new data source needed.
async function runImageGapCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const summary = await getListingReadinessSummary(sellerId);

  if (!summary.rows.length) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No product passports found for image/creative review.",
      evidence: { engineKey: engine.engineKey, productCount: 0 }
    };
  }

  const candidate = summary.rows.find(
    (row) => row.readinessStatus !== "READY" && row.topMissingItems.some((item) => IMAGE_GAP_ITEMS.has(item))
  );

  if (!candidate) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No image/creative gaps found.",
      evidence: { engineKey: engine.engineKey, productCount: summary.rows.length }
    };
  }

  const detail = await getListingReadinessByProductPassportId(candidate.productPassportId);
  const imageSection = detail?.sections.imageReadiness;

  if (!imageSection || imageSection.score >= 60) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No image/creative gaps confirmed after detail review.",
      evidence: { engineKey: engine.engineKey, productPassportId: candidate.productPassportId, imageScore: imageSection?.score ?? null }
    };
  }

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `Image/creative gaps found for ${candidate.sku ?? candidate.asin ?? candidate.productName}.`,
    actionDraft: {
      actionType: "IMAGE_CREATIVE_REVIEW",
      entityType: candidate.asin ? "ASIN" : candidate.sku ? "SKU" : "ACCOUNT",
      entityId: candidate.asin ?? candidate.sku ?? candidate.productPassportId,
      sku: candidate.sku,
      asin: candidate.asin,
      title: `Fix product image gaps for ${candidate.sku ?? candidate.productName ?? candidate.asin ?? "product"}`,
      summary: `Image readiness score is ${imageSection.score}/100. Missing: ${imageSection.missingItems.join(", ")}.`,
      recommendedAction: "IMPROVE_PRODUCT_IMAGES",
      riskLevel: imageSection.score < 30 ? "HIGH" : "MEDIUM",
      confidenceLabel: "HIGH",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        productPassportId: candidate.productPassportId,
        imageScore: imageSection.score,
        missingItems: imageSection.missingItems,
        overallScore: candidate.overallScore
      }
    }
  };
}

// CONTENT_A_PLUS (15 engines): reuses the real, already-live A+ Content coverage scan
// (amazon_aplus_content_cache — populated by real Amazon SP-API Content API calls via
// /api/aplus-content/coverage/scan, same data the founder can already see in-app). Flags
// the first confirmed NO_CONTENT product. If nothing has been checked yet, this says so
// plainly rather than guessing.
async function runContentGapCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const coverage = await getAplusContentCoverage(sellerId);
  const totalProducts = coverage.brands.reduce((sum, brand) => sum + brand.productCount, 0);

  if (!totalProducts) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No active products found for A+ Content review.",
      evidence: { engineKey: engine.engineKey, productCount: 0 }
    };
  }

  const candidate = coverage.missingProducts[0];

  if (!candidate) {
    if (coverage.uncheckedCount > 0) {
      return {
        status: "SKIPPED_NO_DATA",
        summary: `${coverage.uncheckedCount} of ${totalProducts} products have not been checked against Amazon's A+ Content API yet. Run the A+ coverage scan to check them.`,
        evidence: { engineKey: engine.engineKey, uncheckedCount: coverage.uncheckedCount, totalProducts }
      };
    }
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No A+ Content gaps found — every checked product already has A+ Content.",
      evidence: { engineKey: engine.engineKey, totalProducts }
    };
  }

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `No A+ Content found for ${candidate.sku ?? candidate.asin ?? candidate.productName} (confirmed live against Amazon).`,
    actionDraft: {
      actionType: "A_PLUS_CONTENT_REVIEW",
      entityType: candidate.asin ? "ASIN" : candidate.sku ? "SKU" : "ACCOUNT",
      entityId: candidate.asin ?? candidate.sku ?? candidate.productName,
      sku: candidate.sku,
      asin: candidate.asin,
      title: `Build A+ Content for ${candidate.sku ?? candidate.productName ?? candidate.asin ?? "product"}`,
      summary: `Amazon's A+ Content API confirms this ASIN has no A+ Content live today (brand: ${candidate.brand}).`,
      recommendedAction: "CREATE_A_PLUS_CONTENT",
      riskLevel: "LOW",
      confidenceLabel: "HIGH",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        brand: candidate.brand,
        moduleCount: candidate.moduleCount,
        lastCheckedAt: candidate.lastCheckedAt,
        uncheckedCount: coverage.uncheckedCount,
        totalProducts
      }
    }
  };
}

function isCancelledOrderStatus(status: string | null): boolean {
  const normalized = status?.toLowerCase() ?? "";
  return normalized.includes("cancelled") || normalized.includes("canceled");
}

type InventoryVelocityRow = {
  sku: string;
  asin: string | null;
  productName: string | null;
  quantity: number;
  unitsSoldInWindow: number;
  dailyVelocity: number;
  daysOfCover: number | null;
};

async function loadInventoryVelocity(sellerId: string, windowDays: number): Promise<InventoryVelocityRow[]> {
  const { data: listingData, error: listingError } = await supabase
    .from("amazon_sp_listings")
    .select("sku, asin, product_name, quantity")
    .eq("seller_id", sellerId)
    .limit(2000);

  if (listingError) {
    logEngineRouterError("Could not load Amazon SP listings for inventory risk engine.", listingError);
    throw new Error("Could not load Amazon SP listings from Supabase.");
  }

  const listings = (listingData ?? []) as Array<Pick<AmazonSpListingRow, "sku" | "asin" | "product_name" | "quantity">>;

  if (!listings.length) {
    return [];
  }

  const rangeStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: orderData, error: orderError } = await supabase
    .from("amazon_sp_orders")
    .select("amazon_order_id, purchase_date, order_status")
    .eq("seller_id", sellerId)
    .gte("purchase_date", rangeStart)
    .limit(5000);

  if (orderError) {
    logEngineRouterError("Could not load Amazon SP orders for inventory risk engine.", orderError);
    throw new Error("Could not load Amazon SP orders from Supabase.");
  }

  const orders = (orderData ?? []) as Array<Pick<AmazonSpOrderRow, "amazon_order_id" | "purchase_date" | "order_status">>;
  const activeOrderIds = orders.filter((order) => !isCancelledOrderStatus(order.order_status)).map((order) => order.amazon_order_id);

  const unitsSoldBySku = new Map<string, number>();

  if (activeOrderIds.length) {
    const { data: itemData, error: itemError } = await supabase
      .from("amazon_sp_order_items")
      .select("sku, quantity_ordered")
      .eq("seller_id", sellerId)
      .in("amazon_order_id", activeOrderIds.slice(0, 2000))
      .limit(10000);

    if (itemError) {
      logEngineRouterError("Could not load Amazon SP order items for inventory risk engine.", itemError);
      throw new Error("Could not load Amazon SP order items from Supabase.");
    }

    for (const item of (itemData ?? []) as Array<Pick<AmazonSpOrderItemRow, "sku" | "quantity_ordered">>) {
      const sku = cleanText(item.sku);
      if (!sku) continue;
      unitsSoldBySku.set(sku, (unitsSoldBySku.get(sku) ?? 0) + toNumber(item.quantity_ordered));
    }
  }

  return listings
    .map((listing): InventoryVelocityRow | null => {
      const sku = cleanText(listing.sku);
      if (!sku) return null;

      const unitsSoldInWindow = unitsSoldBySku.get(sku) ?? 0;
      const dailyVelocity = unitsSoldInWindow / windowDays;
      const quantity = toNumber(listing.quantity);
      const daysOfCover = dailyVelocity > 0 ? quantity / dailyVelocity : null;

      return {
        sku,
        asin: cleanText(listing.asin),
        productName: cleanText(listing.product_name),
        quantity,
        unitsSoldInWindow,
        dailyVelocity,
        daysOfCover
      };
    })
    .filter((row): row is InventoryVelocityRow => row !== null);
}

// Out-of-stock-with-real-demand is always the worst case; otherwise rank by fewest days of cover
// among SKUs that are actually selling (a SKU with zero sales in the window has no velocity signal
// either way, so it is never flagged here - that is a data-quality gap, not an inventory risk).
// Shared by INVENTORY_RISK_CHECK and SEASONAL_OPPORTUNITY_CHECK so both use the exact same,
// already-tested real-data logic.
function pickWorstInventoryRow(rows: InventoryVelocityRow[]): InventoryVelocityRow | undefined {
  const outOfStockWithDemand = rows
    .filter((row) => row.quantity <= 0 && row.dailyVelocity > 0)
    .sort((a, b) => b.dailyVelocity - a.dailyVelocity)[0];

  const lowCover = rows
    .filter((row) => row.quantity > 0 && row.daysOfCover !== null && row.daysOfCover < 14)
    .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0))[0];

  return outOfStockWithDemand ?? lowCover;
}

async function runInventoryRiskCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const windowDays = toNumber(engine.ruleConfig?.lookbackDays) || 14;
  const rows = await loadInventoryVelocity(sellerId, windowDays);

  if (!rows.length) {
    return {
      status: "SKIPPED_NO_DATA",
      summary: "No Amazon SP listing data found for inventory risk review.",
      evidence: { engineKey: engine.engineKey, listingCount: 0 }
    };
  }

  const worst = pickWorstInventoryRow(rows);

  if (!worst) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: "No stockout or low-cover inventory risk found.",
      evidence: { engineKey: engine.engineKey, listingsChecked: rows.length, windowDays }
    };
  }

  const isOutOfStock = worst.quantity <= 0;
  const riskLevel = isOutOfStock || (worst.daysOfCover !== null && worst.daysOfCover < 7) ? "HIGH" : "MEDIUM";

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: isOutOfStock
      ? `${worst.sku} is out of stock with real recent demand (${roundTo(worst.dailyVelocity, 2)} units/day).`
      : `${worst.sku} has only ${roundTo(worst.daysOfCover ?? 0, 1)} days of stock cover left at current sales velocity.`,
    actionDraft: {
      actionType: "INVENTORY_RISK_REVIEW",
      entityType: worst.asin ? "ASIN" : "SKU",
      entityId: worst.asin ?? worst.sku,
      sku: worst.sku,
      asin: worst.asin,
      title: isOutOfStock ? `Restock ${worst.sku} (out of stock, still selling)` : `Restock ${worst.sku} soon (${roundTo(worst.daysOfCover ?? 0, 1)} days of cover left)`,
      summary: `Sold ${worst.unitsSoldInWindow} units in the last ${windowDays} days (${roundTo(worst.dailyVelocity, 2)}/day); current stock is ${worst.quantity} units.`,
      recommendedAction: "REVIEW_RESTOCK_PLAN",
      riskLevel,
      confidenceLabel: worst.unitsSoldInWindow >= 5 ? "HIGH" : "MEDIUM",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        sku: worst.sku,
        asin: worst.asin,
        productName: worst.productName,
        quantity: worst.quantity,
        unitsSoldInWindow: worst.unitsSoldInWindow,
        dailyVelocity: worst.dailyVelocity,
        daysOfCover: worst.daysOfCover,
        windowDays,
        listingsChecked: rows.length
      }
    }
  };
}

// SEASONALITY (15 engines): fixed, publicly-known Indian shopping/gifting calendar dates
// (verified 2026-09-29, not Amazon-specific promo dates which aren't announced this far out)
// combined with the same real, already-tested inventory-velocity data INVENTORY_RISK_CHECK
// uses. No fabricated "seasonal demand" data anywhere - just a real calendar fact plus real
// current stock/sales data. Only the near-term, already-verified dates are listed; once an
// event passes, it simply stops being "next" - nothing needs to be pruned.
const SEASONAL_EVENTS: Array<{ name: string; date: string }> = [
  { name: "Dussehra / Vijayadashami", date: "2026-10-20" },
  { name: "Diwali", date: "2026-11-08" },
  { name: "Christmas", date: "2026-12-25" },
  { name: "New Year", date: "2027-01-01" },
  { name: "Republic Day", date: "2027-01-26" }
];

function getNextSeasonalEvent(withinDays: number): { name: string; date: string; daysUntil: number } | null {
  const now = Date.now();
  const maxMs = withinDays * 24 * 60 * 60 * 1000;

  const upcoming = SEASONAL_EVENTS.map((event) => ({
    ...event,
    daysUntil: Math.ceil((new Date(`${event.date}T00:00:00Z`).getTime() - now) / (24 * 60 * 60 * 1000))
  }))
    .filter((event) => event.daysUntil >= 0 && event.daysUntil * 24 * 60 * 60 * 1000 <= maxMs)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  return upcoming[0] ?? null;
}

async function runSeasonalOpportunityCheck(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  const windowDays = toNumber(engine.ruleConfig?.lookbackDays) || 60;
  const nextEvent = getNextSeasonalEvent(windowDays);

  if (!nextEvent) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: `No major Indian shopping/gifting event within the next ${windowDays} days.`,
      evidence: { engineKey: engine.engineKey, windowDays }
    };
  }

  const inventoryRows = await loadInventoryVelocity(sellerId, 14);
  const worst = pickWorstInventoryRow(inventoryRows);

  if (!worst) {
    return {
      status: "PREVIEW_NO_ACTION",
      summary: `${nextEvent.name} is on ${nextEvent.date} (${nextEvent.daysUntil} days away). No current stockout or low-cover risk found that would affect it.`,
      evidence: { engineKey: engine.engineKey, event: nextEvent, listingsChecked: inventoryRows.length }
    };
  }

  const isOutOfStock = worst.quantity <= 0;
  const riskLevel = isOutOfStock || (worst.daysOfCover !== null && worst.daysOfCover < 7) ? "HIGH" : "MEDIUM";

  return {
    status: "PREVIEW_ACTION_CREATED",
    summary: `${nextEvent.name} is in ${nextEvent.daysUntil} days (${nextEvent.date}) and ${worst.sku} ${isOutOfStock ? "is already out of stock with real recent demand" : `has only ${roundTo(worst.daysOfCover ?? 0, 1)} days of stock cover left`} - restock before the event or risk missing peak demand sales.`,
    actionDraft: {
      actionType: "SEASONAL_ACTION_REVIEW",
      entityType: worst.asin ? "ASIN" : "SKU",
      entityId: worst.asin ?? worst.sku,
      sku: worst.sku,
      asin: worst.asin,
      title: `Restock ${worst.sku} before ${nextEvent.name} (${nextEvent.date})`,
      summary: `${nextEvent.name} is ${nextEvent.daysUntil} days away. Current stock ${worst.quantity} units, selling ${roundTo(worst.dailyVelocity, 2)} units/day over the last 14 days.`,
      recommendedAction: "REVIEW_RESTOCK_PLAN",
      riskLevel,
      confidenceLabel: worst.unitsSoldInWindow >= 5 ? "HIGH" : "MEDIUM",
      approvalTier: "TIER_2",
      evidence: {
        engineKey: engine.engineKey,
        event: nextEvent,
        sku: worst.sku,
        asin: worst.asin,
        quantity: worst.quantity,
        unitsSoldInWindow: worst.unitsSoldInWindow,
        dailyVelocity: worst.dailyVelocity,
        daysOfCover: worst.daysOfCover,
        listingsChecked: inventoryRows.length
      }
    }
  };
}

async function runDeterministicPreview(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  if (engine.ruleTemplate === "MISSING_DATA_CHECK") return runMissingDataCheck(engine, sellerId);
  if (engine.ruleTemplate === "PROFIT_GUARDRAIL_CHECK") return runProfitGuardrailCheck(engine, sellerId);
  if (engine.ruleTemplate === "ACOS_GUARDRAIL_CHECK") return runAcosGuardrailCheck(engine, sellerId);
  if (engine.ruleTemplate === "LISTING_READINESS_CHECK") return runListingReadinessCheck(engine, sellerId);
  if (engine.ruleTemplate === "ACCOUNT_HEALTH_CHECK") return runAccountHealthCheck(engine, sellerId);
  if (engine.ruleTemplate === "ROAS_OPPORTUNITY_CHECK") return runRoasOpportunityCheck(engine, sellerId);
  if (engine.ruleTemplate === "KEYWORD_OPPORTUNITY_CHECK") return runKeywordOpportunityCheck(engine, sellerId);
  if (engine.ruleTemplate === "NEGATIVE_KEYWORD_REVIEW") return runNegativeKeywordReview(engine, sellerId);
  if (engine.ruleTemplate === "LISTING_SEO_GAP_CHECK") return runListingSeoGapCheck(engine, sellerId);
  if (engine.ruleTemplate === "CONVERSION_RISK_CHECK") return runConversionRiskCheck(engine, sellerId);
  if (engine.ruleTemplate === "PRICING_RISK_CHECK") return runPricingRiskCheck(engine, sellerId);
  if (engine.ruleTemplate === "INVENTORY_RISK_CHECK") return runInventoryRiskCheck(engine, sellerId);
  if (engine.ruleTemplate === "IMAGE_GAP_CHECK") return runImageGapCheck(engine, sellerId);
  if (engine.ruleTemplate === "CONTENT_GAP_CHECK") return runContentGapCheck(engine, sellerId);
  if (engine.ruleTemplate === "SEASONAL_OPPORTUNITY_CHECK") return runSeasonalOpportunityCheck(engine, sellerId);

  return {
    status: "SKIPPED_TEMPLATE_NOT_IMPLEMENTED",
    summary: `Rule template ${engine.ruleTemplate} is not implemented in Generic Runner V1.`,
    skippedReason: "TEMPLATE_NOT_IMPLEMENTED",
    evidence: {
      ruleTemplate: engine.ruleTemplate
    }
  };
}

async function createRunLog(input: {
  sellerId: string;
  actor: string;
  engine: SafeEngineRegistryRow;
  decision: EnginePreviewDecision;
  actionCreated: boolean;
  duplicateSkipped: boolean;
  action: SafeActionLedgerRow | null;
  errorMessage?: string | null;
}): Promise<SafeEngineRunLogRow> {
  const now = new Date().toISOString();
  const insertRow: EngineRunLogInsert = {
    engine_key: input.engine.engineKey,
    seller_id: input.sellerId,
    run_status: input.decision.status,
    run_type: "PREVIEW_ONLY",
    input_snapshot: {
      sellerId: input.sellerId,
      actor: input.actor,
      engineKey: input.engine.engineKey,
      ruleTemplate: input.engine.ruleTemplate,
      previewOnly: true
    },
    output_snapshot: {
      summary: input.decision.summary,
      actionCreated: input.actionCreated,
      duplicateSkipped: input.duplicateSkipped,
      actionId: input.action?.id ?? null,
      skippedReason: input.decision.skippedReason ?? null
    },
    actions_created_count: input.actionCreated ? 1 : 0,
    error_message: input.errorMessage ?? null,
    finished_at: now,
    metadata: {
      engineCategory: input.engine.category,
      shadowMode: true,
      requiresApproval: true,
      externalExecution: false,
      amazonUpdate: false,
      adsUpdate: false,
      listingUpdate: false,
      socialPost: false,
      aiCall: false
    }
  };

  const { data, error } = await supabase
    .from("engine_run_logs")
    .insert(insertRow)
    .select("*")
    .single<EngineRunLogRow>();

  if (error || !data) {
    if (error) logEngineRouterError("Could not create engine router run log.", error);
    throw new Error("Could not create engine run log in Supabase.");
  }

  return toSafeRunLog(data);
}

async function updateEngineLastRun(engine: SafeEngineRegistryRow, status: EngineRunStatus, summary: string): Promise<void> {
  const { error } = await supabase
    .from("engine_registry")
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_run_summary: summary,
      updated_at: new Date().toISOString()
    })
    .eq("engine_key", engine.engineKey);

  if (error) {
    logEngineRouterError("Could not update engine registry last run fields.", error);
    throw new Error("Could not update engine registry last run fields in Supabase.");
  }
}

function learningEventTypeForEngineResult(result: {
  status: EngineRunStatus;
  actionCreated: boolean;
  duplicateSkipped: boolean;
}): LearningEventType {
  if (result.duplicateSkipped) return "DUPLICATE_ACTION_SKIPPED";
  if (result.actionCreated) return "ENGINE_PREVIEW_ACTION_CREATED";
  if (result.status === "PREVIEW_NO_ACTION") return "ENGINE_PREVIEW_NO_ACTION";
  if (result.status === "SKIPPED_NO_DATA") return "ENGINE_SKIPPED_NO_DATA";
  if (result.status === "SKIPPED_TEMPLATE_NOT_IMPLEMENTED") return "ENGINE_SKIPPED_TEMPLATE_NOT_IMPLEMENTED";
  return "ENGINE_FAILED";
}

async function recordEngineLearning(input: {
  sellerId: string;
  actor: string;
  engine: SafeEngineRegistryRow;
  status: EngineRunStatus;
  summary: string;
  actionCreated: boolean;
  duplicateSkipped: boolean;
  action: SafeActionLedgerRow | null;
  log: SafeEngineRunLogRow;
}): Promise<void> {
  await recordLearningEventSafe({
    sellerId: input.sellerId,
    actionId: input.action?.id ?? null,
    engineKey: input.engine.engineKey,
    source: "ENGINE_ROUTER",
    sourceId: input.action?.sourceId ?? input.log.id,
    actionType: input.action?.actionType ?? input.engine.outputActionType,
    entityType: input.action?.entityType ?? input.engine.outputEntityType,
    entityId: input.action?.entityId ?? null,
    sku: input.action?.sku ?? null,
    asin: input.action?.asin ?? null,
    eventType: learningEventTypeForEngineResult(input),
    actor: input.actor,
    note: input.summary,
    evidence: {
      engineName: input.engine.engineName,
      category: input.engine.category,
      ruleTemplate: input.engine.ruleTemplate,
      runStatus: input.status,
      logId: input.log.id
    },
    metadata: {
      engineRouter: true,
      actionCreated: input.actionCreated,
      duplicateSkipped: input.duplicateSkipped,
      previewOnly: true
    }
  });
}

async function runEngine(engine: SafeEngineRegistryRow, sellerId: string, actor: string): Promise<EngineRunResult> {
  try {
    const decision = await runDeterministicPreview(engine, sellerId);
    const actionResult = await createActionIfUseful({ sellerId, actor, engine, decision });
    const status: EngineRunStatus =
      actionResult.actionCreated ? "PREVIEW_ACTION_CREATED" : decision.status === "PREVIEW_ACTION_CREATED" ? "PREVIEW_NO_ACTION" : decision.status;
    const summary = actionResult.duplicateSkipped && decision.actionDraft
      ? `${decision.summary} Pending duplicate already exists.`
      : decision.summary;
    const finalDecision = { ...decision, status, summary };
    const log = await createRunLog({
      sellerId,
      actor,
      engine,
      decision: finalDecision,
      ...actionResult
    });

    await updateEngineLastRun(engine, status, summary);
    await recordEngineLearning({
      sellerId,
      actor,
      engine,
      status,
      summary,
      ...actionResult,
      log
    });

    return {
      engine,
      status,
      summary,
      actionCreated: actionResult.actionCreated,
      duplicateSkipped: actionResult.duplicateSkipped,
      action: actionResult.action,
      log
    };
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown engine runner error");
    const decision: EnginePreviewDecision = {
      status: "FAILED",
      summary: "Engine preview failed safely.",
      evidence: {},
      skippedReason: "FAILED"
    };
    const log = await createRunLog({
      sellerId,
      actor,
      engine,
      decision,
      actionCreated: false,
      duplicateSkipped: false,
      action: null,
      errorMessage: message
    });
    await updateEngineLastRun(engine, "FAILED", message);
    await recordEngineLearning({
      sellerId,
      actor,
      engine,
      status: "FAILED",
      summary: message,
      actionCreated: false,
      duplicateSkipped: false,
      action: null,
      log
    });

    return {
      engine,
      status: "FAILED",
      summary: message,
      actionCreated: false,
      duplicateSkipped: false,
      action: null,
      log
    };
  }
}

export async function getDailyEnginePlan(input: {
  sellerId: string;
  limit: number;
  categories?: string[];
}): Promise<{ ok: true; sellerId: string; count: number; engines: SafeEngineRegistryRow[] }> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
  const engines = await loadRunnableEngines({ limit, categories: input.categories });

  return {
    ok: true,
    sellerId,
    count: engines.length,
    engines
  };
}

export async function runEngineRouterPreview(input: EngineRouterRunPreviewInput): Promise<{
  ok: true;
  sellerId: string;
  runMode: "PREVIEW_ONLY";
  enginesScanned: number;
  enginesRun: number;
  actionsCreated: number;
  skippedCount: number;
  logs: SafeEngineRunLogRow[];
  results: EngineRunResult[];
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 50);
  const engines = await loadRunnableEngines({ limit, categories: input.categories });
  const results: EngineRunResult[] = [];

  for (const engine of engines) {
    results.push(await runEngine(engine, sellerId, cleanText(input.actor) ?? "founder"));
  }

  await safeRecordActivityLog({
    sellerId,
    eventType: "ENGINE_ROUTER_RUN_COMPLETED",
    eventCategory: "ENGINE_ROUTER",
    severity: results.some((result) => result.status === "FAILED") ? "WARNING" : "INFO",
    actor: cleanText(input.actor) ?? "founder",
    title: "Engine Router preview run completed",
    message: "Engine Router completed a preview-only run. No external action executed.",
    sourceModule: "engine-router",
    metadata: {
      enginesScanned: engines.length,
      enginesRun: results.filter((result) => result.status !== "FAILED").length,
      actionsCreated: results.filter((result) => result.actionCreated).length,
      failedCount: results.filter((result) => result.status === "FAILED").length,
      previewOnly: true
    }
  });

  return {
    ok: true,
    sellerId,
    runMode: "PREVIEW_ONLY",
    enginesScanned: engines.length,
    enginesRun: results.filter((result) => result.status !== "FAILED").length,
    actionsCreated: results.filter((result) => result.actionCreated).length,
    skippedCount: results.filter((result) => result.status.startsWith("SKIPPED")).length,
    logs: results.map((result) => result.log),
    results
  };
}

export async function runSingleEnginePreview(input: {
  engineKey: string;
  sellerId: string;
  actor: string;
}): Promise<EngineRunResult | null> {
  const engine = await getEngineByKey(input.engineKey);
  if (!engine) return null;

  return runEngine(engine, cleanText(input.sellerId) ?? "default", cleanText(input.actor) ?? "founder");
}

export async function listEngineRunLogs(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeEngineRunLogRow[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
  const { data, error } = await supabase
    .from("engine_run_logs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    logEngineRouterError("Could not load engine router run logs.", error);
    throw new Error("Could not load engine run logs from Supabase.");
  }

  return ((data ?? []) as EngineRunLogRow[]).map(toSafeRunLog);
}

export async function getEngineRouterSummary(sellerIdInput: string): Promise<EngineRouterSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [totalResult, enabledResult, logsResult] = await Promise.all([
    supabase.from("engine_registry").select("id", { count: "exact", head: true }),
    supabase
      .from("engine_registry")
      .select("id", { count: "exact", head: true })
      .eq("enabled", true)
      .eq("shadow_mode", true)
      .eq("requires_approval", true),
    supabase
      .from("engine_run_logs")
      .select("engine_key, run_status, run_type, actions_created_count, started_at")
      .eq("seller_id", sellerId)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1000)
  ]);

  if (totalResult.error) {
    logEngineRouterError("Could not count engine registry rows.", totalResult.error);
    throw new Error("Could not summarize engine router from Supabase.");
  }
  if (enabledResult.error) {
    logEngineRouterError("Could not count enabled engine registry rows.", enabledResult.error);
    throw new Error("Could not summarize engine router from Supabase.");
  }
  if (logsResult.error) {
    logEngineRouterError("Could not load engine run logs for summary.", logsResult.error);
    throw new Error("Could not summarize engine router from Supabase.");
  }

  const logRows = (logsResult.data ?? []) as Array<{
    engine_key: string;
    run_status: string;
    run_type: string;
    actions_created_count: number | string;
  }>;
  const engineKeys = [...new Set(logRows.map((row) => row.engine_key))];
  const categoryByEngine = new Map<string, string>();

  if (engineKeys.length) {
    const { data, error } = await supabase
      .from("engine_registry")
      .select("engine_key, category")
      .in("engine_key", engineKeys);

    if (error) {
      logEngineRouterError("Could not load engine categories for summary.", error);
    } else {
      for (const row of (data ?? []) as Array<{ engine_key: string; category: string }>) {
        categoryByEngine.set(row.engine_key, row.category);
      }
    }
  }

  const topCategoriesRun = logRows.reduce<Record<string, number>>((counts, row) => {
    const category = categoryByEngine.get(row.engine_key) ?? "UNKNOWN";
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, {});

  return {
    ok: true,
    sellerId,
    totalEngines: totalResult.count ?? 0,
    enabledEngines: enabledResult.count ?? 0,
    last24hRuns: logRows.length,
    last24hActionsCreated: logRows.reduce((total, row) => total + toNumber(row.actions_created_count), 0),
    failedRuns: logRows.filter((row) => row.run_status === "FAILED").length,
    previewOnlyRuns: logRows.filter((row) => row.run_type === "PREVIEW_ONLY").length,
    topCategoriesRun
  };
}
