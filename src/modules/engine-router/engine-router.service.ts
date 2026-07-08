import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import {
  ActionLedgerActionType,
  ActionLedgerApprovalTier,
  ActionLedgerEntityType,
  ActionLedgerRiskLevel,
  SafeActionLedgerRow
} from "../action-ledger/action-ledger.types";
import { recordWorkflowEvent } from "../action-ledger/action-workflow.service";
import { getDailyCeoReport } from "../ceo-report/ceo-report.service";
import { EngineRegistryRow, EngineRunLogRow, SafeEngineRegistryRow, SafeEngineRunLogRow } from "../engine-registry/engine-registry.types";
import { getCostCompletionQueue, listProductEconomics } from "../product-economics/product-economics.service";
import { CostCompletionQueueRow, SafeProductEconomicsRow } from "../product-economics/product-economics.types";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import {
  EnginePreviewDecision,
  EngineRouterActionDraft,
  EngineRouterRunPreviewInput,
  EngineRouterSummary,
  EngineRunResult,
  EngineRunStatus
} from "./engine-router.types";

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

async function runDeterministicPreview(engine: SafeEngineRegistryRow, sellerId: string): Promise<EnginePreviewDecision> {
  if (engine.ruleTemplate === "MISSING_DATA_CHECK") return runMissingDataCheck(engine, sellerId);
  if (engine.ruleTemplate === "PROFIT_GUARDRAIL_CHECK") return runProfitGuardrailCheck(engine, sellerId);
  if (engine.ruleTemplate === "ACOS_GUARDRAIL_CHECK") return runAcosGuardrailCheck(engine, sellerId);
  if (engine.ruleTemplate === "LISTING_READINESS_CHECK") return runListingReadinessCheck(engine, sellerId);
  if (engine.ruleTemplate === "ACCOUNT_HEALTH_CHECK") return runAccountHealthCheck(engine, sellerId);

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
