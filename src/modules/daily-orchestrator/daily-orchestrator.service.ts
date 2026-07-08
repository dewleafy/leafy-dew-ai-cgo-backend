import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getActionLedgerSummary } from "../action-ledger/action-ledger.service";
import { getDailyEnginePlan, runEngineRouterPreview } from "../engine-router/engine-router.service";
import { listProductEconomics } from "../product-economics/product-economics.service";
import { getProductPassportCostCompletionSummary } from "../product-passports/product-passports-cost-completion.service";
import {
  DailyOrchestratorCounts,
  DailyOrchestratorDataReadiness,
  DailyOrchestratorRunInput,
  DailyOrchestratorRunResponse,
  DailyOrchestratorRunRow,
  DailyOrchestratorSafetyMetadata,
  DailyOrchestratorStatusResponse,
  SafeDailyOrchestratorRun
} from "./daily-orchestrator.types";

export const DAILY_ORCHESTRATOR_SAFETY_METADATA: DailyOrchestratorSafetyMetadata = {
  shadowMode: true,
  externalExecution: false,
  amazonUpdate: false,
  adsUpdate: false,
  listingUpdate: false,
  socialPost: false,
  aiCall: false
};

type ReadinessContext = {
  sellerId: string;
  dataReadiness: DailyOrchestratorDataReadiness;
  counts: DailyOrchestratorCounts;
  warnings: string[];
  engineRegistryAvailable: boolean;
  approvalCenterAvailable: boolean;
  costCompletionSummary: Record<string, unknown> | null;
  productEconomicsSummary: Record<string, unknown> | null;
};

export class DailyOrchestratorSafeError extends Error {
  constructor(message: string, readonly runId?: string) {
    super(message);
  }
}

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function logDailyOrchestratorError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function toSafeDailyOrchestratorRun(row: DailyOrchestratorRunRow): SafeDailyOrchestratorRun {
  return {
    id: row.id,
    sellerId: row.seller_id,
    runType: row.run_type,
    runStatus: row.run_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    enginesPlanned: toNumber(row.engines_planned),
    enginesRun: toNumber(row.engines_run),
    actionsCreated: toNumber(row.actions_created),
    skippedCount: toNumber(row.skipped_count),
    failedCount: toNumber(row.failed_count),
    approvalPendingBefore: row.approval_pending_before === null ? null : toNumber(row.approval_pending_before),
    approvalPendingAfter: row.approval_pending_after === null ? null : toNumber(row.approval_pending_after),
    dataReadiness: toJsonObject(row.data_readiness),
    engineSummary: toJsonObject(row.engine_summary),
    actionSummary: toJsonObject(row.action_summary),
    warnings: toArray(row.warnings),
    recommendations: toArray(row.recommendations),
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

async function countEngineRegistryRows(): Promise<{ totalEngines: number; enabledEngines: number; available: boolean; warning: string | null }> {
  const [totalResult, enabledResult] = await Promise.all([
    supabase.from("engine_registry").select("id", { count: "exact", head: true }),
    supabase
      .from("engine_registry")
      .select("id", { count: "exact", head: true })
      .eq("enabled", true)
      .eq("shadow_mode", true)
      .eq("requires_approval", true)
  ]);

  if (totalResult.error) {
    logDailyOrchestratorError("Could not count engine registry rows for daily orchestrator.", totalResult.error);
    return {
      totalEngines: 0,
      enabledEngines: 0,
      available: false,
      warning: "Engine Registry is not reachable. Run engine_registry.sql and confirm Supabase access."
    };
  }

  if (enabledResult.error) {
    logDailyOrchestratorError("Could not count enabled engine registry rows for daily orchestrator.", enabledResult.error);
    return {
      totalEngines: totalResult.count ?? 0,
      enabledEngines: 0,
      available: true,
      warning: "Enabled shadow-mode engines could not be counted."
    };
  }

  return {
    totalEngines: totalResult.count ?? 0,
    enabledEngines: enabledResult.count ?? 0,
    available: true,
    warning: null
  };
}

async function summarizeLast24hEngineRuns(sellerId: string): Promise<{ runs: number; actionsCreated: number; warning: string | null }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("engine_run_logs")
    .select("actions_created_count")
    .eq("seller_id", sellerId)
    .gte("started_at", since)
    .limit(5000);

  if (error) {
    logDailyOrchestratorError("Could not summarize recent engine run logs for daily orchestrator.", error);
    return {
      runs: 0,
      actionsCreated: 0,
      warning: "Recent Engine Router run logs are not reachable."
    };
  }

  const rows = (data ?? []) as Array<{ actions_created_count: number | string | null }>;
  return {
    runs: rows.length,
    actionsCreated: rows.reduce((total, row) => total + toNumber(row.actions_created_count), 0),
    warning: null
  };
}

async function collectReadiness(sellerIdInput: string): Promise<ReadinessContext> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const warnings: string[] = [];
  const engineCounts = await countEngineRegistryRows();
  if (engineCounts.warning) warnings.push(engineCounts.warning);

  const recentRuns = await summarizeLast24hEngineRuns(sellerId);
  if (recentRuns.warning) warnings.push(recentRuns.warning);

  let pendingApprovals = 0;
  let approvalCenterAvailable = false;
  try {
    const actionSummary = await getActionLedgerSummary(sellerId);
    pendingApprovals = actionSummary.pendingCount;
    approvalCenterAvailable = true;
  } catch (error) {
    logger.warn("Could not summarize Action Ledger for daily orchestrator readiness.", {
      sellerId,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown action ledger error")
    });
    warnings.push("Approval Center / Action Ledger is not reachable.");
  }

  let costCompletionSummary: Record<string, unknown> | null = null;
  let productPassportAvailable = false;
  try {
    const summary = await getProductPassportCostCompletionSummary(sellerId);
    costCompletionSummary = summary as unknown as Record<string, unknown>;
    productPassportAvailable = true;

    if (summary.totalSkus === 0) {
      warnings.push("Product Passport cost completion has no SKU rows yet.");
    }
    if (summary.incompleteCount > 0 || summary.partialCount > 0 || summary.missingCostCount > 0) {
      warnings.push("Cost data is incomplete for one or more products.");
    }
  } catch (error) {
    logger.warn("Could not summarize Product Passport cost completion for daily orchestrator readiness.", {
      sellerId,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown cost completion error")
    });
    warnings.push("Product Passport cost completion summary is missing or partial.");
  }

  let productEconomicsSummary: Record<string, unknown> | null = null;
  let productEconomicsAvailable = false;
  try {
    const economicsRows = await listProductEconomics(sellerId);
    productEconomicsAvailable = true;
    productEconomicsSummary = {
      rows: economicsRows.length,
      partialRows: economicsRows.filter((row) => row.profitDataStatus !== "AVAILABLE").length,
      blockedRows: economicsRows.filter((row) => ["BLOCKED", "FAIL", "NEEDS_COST_DATA", "NEEDS_INPUT"].includes(row.profitStatus)).length
    };

    if (!economicsRows.length) {
      warnings.push("Product economics data is missing or empty.");
    } else if (toNumber(productEconomicsSummary.partialRows) > 0) {
      warnings.push("Product economics is partial for one or more products.");
    }
  } catch (error) {
    logger.warn("Could not load Product Economics for daily orchestrator readiness.", {
      sellerId,
      message: sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown product economics error")
    });
    warnings.push("Product economics is missing or partial.");
  }

  const dataReadiness: DailyOrchestratorDataReadiness = {
    productPassportAvailable,
    productEconomicsAvailable,
    engineRegistryReady: engineCounts.totalEngines >= 300,
    engineRouterReady: engineCounts.enabledEngines > 0,
    approvalCenterReady: approvalCenterAvailable
  };

  if (!dataReadiness.engineRegistryReady) {
    warnings.push("Engine Registry is not ready: fewer than 300 engines are registered.");
  }
  if (!dataReadiness.engineRouterReady) {
    warnings.push("Engine Router has no enabled shadow-mode approval engines to run.");
  }
  if (pendingApprovals >= 50) {
    warnings.push("Approval Center has a high pending approval backlog.");
  }

  return {
    sellerId,
    dataReadiness,
    counts: {
      totalEngines: engineCounts.totalEngines,
      enabledEngines: engineCounts.enabledEngines,
      pendingApprovals,
      last24hEngineRuns: recentRuns.runs,
      last24hActionsCreated: recentRuns.actionsCreated
    },
    warnings: uniqueStrings(warnings),
    engineRegistryAvailable: engineCounts.available,
    approvalCenterAvailable,
    costCompletionSummary,
    productEconomicsSummary
  };
}

function buildRecommendations(input: {
  pendingApprovals: number;
  warnings: string[];
  actionsCreated: number;
  failedCount: number;
}): string[] {
  const recommendations: string[] = [];

  if (input.pendingApprovals > 0) {
    recommendations.push("Review high-risk Approval Center actions first.");
  }
  if (input.warnings.some((warning) => warning.toLowerCase().includes("cost"))) {
    recommendations.push("Complete missing product cost data before broad PPC scaling.");
  }
  if (input.actionsCreated > 0) {
    recommendations.push("Review new Action Ledger recommendations before taking marketplace action.");
  }
  if (input.failedCount > 0) {
    recommendations.push("Review failed engine summaries before expanding the daily run limit.");
  }

  recommendations.push("Review PPC guardrail actions before increasing budgets.");
  recommendations.push("Keep shadow mode until approval/execution safety is tested.");

  return uniqueStrings(recommendations);
}

async function createRunRow(input: {
  sellerId: string;
  runType: string;
  actor: string;
  limit: number;
  categories?: string[];
}): Promise<SafeDailyOrchestratorRun> {
  const { data, error } = await supabase
    .from("daily_orchestrator_runs")
    .insert({
      seller_id: input.sellerId,
      run_type: input.runType,
      run_status: "RUNNING",
      metadata: {
        ...DAILY_ORCHESTRATOR_SAFETY_METADATA,
        actor: input.actor,
        requestedLimit: input.limit,
        categories: input.categories ?? [],
        runMode: "PREVIEW_ONLY"
      }
    })
    .select("*")
    .single<DailyOrchestratorRunRow>();

  if (error || !data) {
    if (error) logDailyOrchestratorError("Could not create daily orchestrator run row.", error);
    throw new DailyOrchestratorSafeError("Could not create daily orchestrator run row. Run daily_orchestrator.sql in Supabase.");
  }

  return toSafeDailyOrchestratorRun(data);
}

async function updateRunRow(input: {
  runId: string;
  runStatus: "COMPLETED" | "FAILED";
  enginesPlanned: number;
  enginesRun: number;
  actionsCreated: number;
  skippedCount: number;
  failedCount: number;
  approvalPendingBefore: number | null;
  approvalPendingAfter: number | null;
  dataReadiness: DailyOrchestratorDataReadiness | Record<string, unknown>;
  engineSummary: Record<string, unknown>;
  actionSummary: Record<string, unknown>;
  warnings: string[];
  recommendations: string[];
  metadata?: Record<string, unknown>;
}): Promise<SafeDailyOrchestratorRun> {
  const { data, error } = await supabase
    .from("daily_orchestrator_runs")
    .update({
      run_status: input.runStatus,
      finished_at: new Date().toISOString(),
      engines_planned: input.enginesPlanned,
      engines_run: input.enginesRun,
      actions_created: input.actionsCreated,
      skipped_count: input.skippedCount,
      failed_count: input.failedCount,
      approval_pending_before: input.approvalPendingBefore,
      approval_pending_after: input.approvalPendingAfter,
      data_readiness: input.dataReadiness,
      engine_summary: input.engineSummary,
      action_summary: input.actionSummary,
      warnings: input.warnings,
      recommendations: input.recommendations,
      metadata: {
        ...DAILY_ORCHESTRATOR_SAFETY_METADATA,
        ...(input.metadata ?? {})
      }
    })
    .eq("id", input.runId)
    .select("*")
    .single<DailyOrchestratorRunRow>();

  if (error || !data) {
    if (error) logDailyOrchestratorError("Could not update daily orchestrator run row.", error);
    throw new DailyOrchestratorSafeError("Could not update daily orchestrator run row.", input.runId);
  }

  return toSafeDailyOrchestratorRun(data);
}

export async function getDailyOrchestratorStatus(sellerIdInput: string): Promise<DailyOrchestratorStatusResponse> {
  const readiness = await collectReadiness(sellerIdInput);

  return {
    ok: true,
    sellerId: readiness.sellerId,
    mode: "SHADOW",
    dataReadiness: readiness.dataReadiness,
    counts: readiness.counts,
    warnings: readiness.warnings
  };
}

export async function runDailyOrchestrator(input: DailyOrchestratorRunInput): Promise<DailyOrchestratorRunResponse> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const actor = cleanText(input.actor) ?? "founder";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 50);
  const categories = (input.categories ?? []).map(cleanText).filter((value): value is string => Boolean(value));
  const runType = cleanText(input.runType) ?? "MANUAL";
  const run = await createRunRow({ sellerId, runType, actor, limit, categories });

  try {
    const readiness = await collectReadiness(sellerId);
    const approvalPendingBefore = readiness.counts.pendingApprovals;

    if (!readiness.engineRegistryAvailable || !readiness.approvalCenterAvailable) {
      const warnings = uniqueStrings([
        ...readiness.warnings,
        "Daily orchestration stopped before engine execution because Engine Registry or Action Ledger is unavailable."
      ]);
      const recommendations = buildRecommendations({
        pendingApprovals: approvalPendingBefore,
        warnings,
        actionsCreated: 0,
        failedCount: 0
      });

      await updateRunRow({
        runId: run.id,
        runStatus: "FAILED",
        enginesPlanned: 0,
        enginesRun: 0,
        actionsCreated: 0,
        skippedCount: 0,
        failedCount: 0,
        approvalPendingBefore,
        approvalPendingAfter: approvalPendingBefore,
        dataReadiness: readiness.dataReadiness,
        engineSummary: {},
        actionSummary: {
          pendingBefore: approvalPendingBefore,
          pendingAfter: approvalPendingBefore,
          newPendingDelta: 0
        },
        warnings,
        recommendations,
        metadata: {
          actor,
          runType,
          failureReason: "READINESS_BLOCKED"
        }
      });

      throw new DailyOrchestratorSafeError("Daily orchestration could not run because required readiness checks failed. No external action executed.", run.id);
    }

    const plan = await getDailyEnginePlan({ sellerId, limit, categories });
    const routerResult = await runEngineRouterPreview({
      sellerId,
      actor,
      limit,
      categories
    });
    const afterSummary = await getActionLedgerSummary(sellerId);
    const approvalPendingAfter = afterSummary.pendingCount;
    const pendingDelta = Math.max(approvalPendingAfter - approvalPendingBefore, 0);
    const actionsCreated = Math.max(routerResult.actionsCreated, pendingDelta);
    const failedCount = routerResult.results.filter((result) => result.status === "FAILED").length;
    const warnings = uniqueStrings([
      ...readiness.warnings,
      ...(failedCount > 0 ? ["One or more engine preview runs failed safely."] : []),
      ...(routerResult.enginesRun === 0 ? ["No engines ran during daily orchestration."] : [])
    ]);
    const recommendations = buildRecommendations({
      pendingApprovals: approvalPendingAfter,
      warnings,
      actionsCreated,
      failedCount
    });
    const engineSummary = {
      plannedEngineKeys: plan.engines.map((engine) => engine.engineKey),
      plannedCount: plan.count,
      routerRunMode: routerResult.runMode,
      enginesScanned: routerResult.enginesScanned,
      enginesRun: routerResult.enginesRun,
      actionsCreated: routerResult.actionsCreated,
      skippedCount: routerResult.skippedCount,
      failedCount,
      results: routerResult.results.map((result) => ({
        engineKey: result.engine.engineKey,
        engineName: result.engine.engineName,
        category: result.engine.category,
        status: result.status,
        summary: result.summary,
        actionCreated: result.actionCreated,
        duplicateSkipped: result.duplicateSkipped,
        actionId: result.action?.id ?? null,
        logId: result.log.id
      }))
    };
    const actionSummary = {
      pendingBefore: approvalPendingBefore,
      pendingAfter: approvalPendingAfter,
      newPendingDelta: pendingDelta,
      routerActionsCreated: routerResult.actionsCreated,
      trustedActionsCreated: actionsCreated
    };

    await updateRunRow({
      runId: run.id,
      runStatus: "COMPLETED",
      enginesPlanned: plan.count,
      enginesRun: routerResult.enginesRun,
      actionsCreated,
      skippedCount: routerResult.skippedCount,
      failedCount,
      approvalPendingBefore,
      approvalPendingAfter,
      dataReadiness: readiness.dataReadiness,
      engineSummary,
      actionSummary,
      warnings,
      recommendations,
      metadata: {
        actor,
        runType,
        limit,
        categories,
        mode: "SHADOW",
        runMode: "PREVIEW_ONLY",
        costCompletionSummary: readiness.costCompletionSummary,
        productEconomicsSummary: readiness.productEconomicsSummary
      }
    });

    return {
      ok: true,
      sellerId,
      runId: run.id,
      mode: "SHADOW",
      runStatus: "COMPLETED",
      enginesPlanned: plan.count,
      enginesRun: routerResult.enginesRun,
      actionsCreated,
      skippedCount: routerResult.skippedCount,
      failedCount,
      approvalPendingBefore,
      approvalPendingAfter,
      warnings,
      recommendations,
      metadata: DAILY_ORCHESTRATOR_SAFETY_METADATA,
      message: "Daily AI-CGO run completed in shadow mode. No external action executed."
    };
  } catch (error) {
    if (error instanceof DailyOrchestratorSafeError) {
      throw error;
    }

    const safeMessage = sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown daily orchestrator error");
    logger.warn("Daily orchestrator run failed safely.", {
      sellerId,
      runId: run.id,
      message: safeMessage
    });

    await updateRunRow({
      runId: run.id,
      runStatus: "FAILED",
      enginesPlanned: 0,
      enginesRun: 0,
      actionsCreated: 0,
      skippedCount: 0,
      failedCount: 1,
      approvalPendingBefore: null,
      approvalPendingAfter: null,
      dataReadiness: {},
      engineSummary: {},
      actionSummary: {},
      warnings: ["Daily orchestration failed safely. No external action was executed."],
      recommendations: ["Review backend logs and database readiness before retrying.", "Keep shadow mode until approval/execution safety is tested."],
      metadata: {
        actor,
        runType,
        error: safeMessage
      }
    }).catch((updateError) => {
      logger.warn("Could not mark daily orchestrator run as failed.", {
        sellerId,
        runId: run.id,
        message: sanitizeErrorMessage(updateError instanceof Error ? updateError.message : "Unknown update failure")
      });
    });

    throw new DailyOrchestratorSafeError("Daily orchestration failed safely. No external action executed.", run.id);
  }
}

export async function listDailyOrchestratorRuns(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeDailyOrchestratorRun[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
  const { data, error } = await supabase
    .from("daily_orchestrator_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    logDailyOrchestratorError("Could not list daily orchestrator runs.", error);
    throw new Error("Could not load daily orchestrator runs from Supabase.");
  }

  return ((data ?? []) as DailyOrchestratorRunRow[]).map(toSafeDailyOrchestratorRun);
}

export async function getDailyOrchestratorRunById(input: {
  id: string;
  sellerId: string;
}): Promise<SafeDailyOrchestratorRun | null> {
  const id = cleanText(input.id);
  const sellerId = cleanText(input.sellerId) ?? "default";
  if (!id) return null;

  const { data, error } = await supabase
    .from("daily_orchestrator_runs")
    .select("*")
    .eq("id", id)
    .eq("seller_id", sellerId)
    .maybeSingle<DailyOrchestratorRunRow>();

  if (error) {
    logDailyOrchestratorError("Could not load daily orchestrator run detail.", error);
    throw new Error("Could not load daily orchestrator run from Supabase.");
  }

  return data ? toSafeDailyOrchestratorRun(data) : null;
}
