import { supabase } from "../../db/supabase";
import { getActionLedgerSummary, getDailyPriorities } from "../action-ledger/action-ledger.service";
import { getAlertSummary } from "../alert-center/alert-center.service";
import { getAiCostSummary } from "../ai-gateway/ai-gateway.service";
import { getCriticalDataSourceSet, getDataFreshnessSummary } from "../data-freshness/data-freshness.service";
import { getEngineRouterSummary } from "../engine-router/engine-router.service";
import { getExperimentSummary } from "../experiments/experiments.service";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { TodayCommandCounts, TodayCommandSummary, TodayCommandSystemStatus } from "./today-command.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function safeCount(input: {
  table: string;
  sellerId?: string;
  filters?: Array<{ column: string; value: string | number | boolean }>;
  sinceColumn?: string;
  sinceIso?: string;
}): Promise<{ count: number; ready: boolean; warning: string | null }> {
  let query = supabase.from(input.table).select("id", { count: "exact", head: true });

  if (input.sellerId) query = query.eq("seller_id", input.sellerId);
  for (const filter of input.filters ?? []) {
    query = query.eq(filter.column, filter.value);
  }
  if (input.sinceColumn && input.sinceIso) {
    query = query.gte(input.sinceColumn, input.sinceIso);
  }

  const { count, error } = await query;
  if (error) {
    return {
      count: 0,
      ready: false,
      warning: `${input.table} is not reachable.`
    };
  }

  return {
    count: count ?? 0,
    ready: true,
    warning: null
  };
}

async function safeActionSummary(sellerId: string): Promise<{
  ready: boolean;
  pending: number;
  approved: number;
  completed: number;
  rejected: number;
  topRisks: unknown[];
  warning: string | null;
}> {
  try {
    const summary = await getActionLedgerSummary(sellerId);
    return {
      ready: true,
      pending: summary.pendingCount,
      approved: summary.approvedCount,
      completed: summary.completedCount,
      rejected: summary.rejectedCount,
      topRisks: summary.latestActions.filter((row) => row.riskLevel === "HIGH" || row.riskLevel === "CRITICAL").slice(0, 5),
      warning: null
    };
  } catch {
    return {
      ready: false,
      pending: 0,
      approved: 0,
      completed: 0,
      rejected: 0,
      topRisks: [],
      warning: "Action Ledger / Approval Center is not reachable."
    };
  }
}

async function safePriorities(sellerId: string): Promise<{ rows: unknown[]; warning: string | null }> {
  try {
    const priorities = await getDailyPriorities({ sellerId, limit: 10 });
    return { rows: priorities.rows, warning: null };
  } catch {
    return { rows: [], warning: "Today priorities could not be loaded from Action Ledger." };
  }
}

async function safeEngineSummary(sellerId: string): Promise<{
  ready: boolean;
  routerReady: boolean;
  totalEngines: number;
  enabledEngines: number;
  last24hRuns: number;
  last24hActionsCreated: number;
  warning: string | null;
}> {
  try {
    const summary = await getEngineRouterSummary(sellerId);
    return {
      ready: true,
      routerReady: true,
      totalEngines: summary.totalEngines,
      enabledEngines: summary.enabledEngines,
      last24hRuns: summary.last24hRuns,
      last24hActionsCreated: summary.last24hActionsCreated,
      warning: null
    };
  } catch {
    return {
      ready: false,
      routerReady: false,
      totalEngines: 0,
      enabledEngines: 0,
      last24hRuns: 0,
      last24hActionsCreated: 0,
      warning: "Engine Registry / Engine Router summary is not reachable."
    };
  }
}

function buildNextBestActions(input: {
  pendingApprovals: number;
  listingDrafts: number;
  creativeRecommendations: number;
  openAlerts: number;
  staleDataSources: number;
  runningExperiments: number;
  failedReadiness: string[];
}): string[] {
  const actions: string[] = [];

  if (input.openAlerts > 0) actions.push("Review open high severity alerts.");
  if (input.staleDataSources > 0) actions.push("Check stale data sources.");
  if (input.runningExperiments > 0) actions.push("Review running experiments.");
  if (input.pendingApprovals > 0) actions.push("Review pending approval actions.");
  if (input.listingDrafts > 0) actions.push("Review listing optimization drafts awaiting approval.");
  if (input.creativeRecommendations > 0) actions.push("Review image and A+ recommendations awaiting approval.");
  if (input.failedReadiness.length > 0) actions.push("Resolve backend readiness warnings before expanding automation.");
  actions.push("Keep live execution blocked until QA passes.");
  actions.push("Review AI gateway budget before enabling AI calls.");
  actions.push("Keep all marketplace actions in shadow mode.");

  return [...new Set(actions)].slice(0, 8);
}

async function safeAlertSummary(sellerId: string): Promise<{
  ready: boolean;
  openAlerts: number;
  highAlerts: number;
  topRisks: unknown[];
  warning: string | null;
}> {
  try {
    const summary = await getAlertSummary(sellerId);
    return {
      ready: true,
      openAlerts: summary.openAlerts,
      highAlerts: summary.highAlerts + summary.criticalAlerts,
      topRisks: summary.latestOpenAlerts.filter((row) => row.severity === "HIGH" || row.severity === "CRITICAL").slice(0, 5),
      warning: null
    };
  } catch {
    return { ready: false, openAlerts: 0, highAlerts: 0, topRisks: [], warning: "Alert Center is not reachable." };
  }
}

async function safeExperimentSummary(sellerId: string): Promise<{
  ready: boolean;
  runningExperiments: number;
  completedExperiments: number;
  warning: string | null;
}> {
  try {
    const summary = await getExperimentSummary(sellerId);
    return {
      ready: true,
      runningExperiments: summary.runningExperiments,
      completedExperiments: summary.completedExperiments,
      warning: null
    };
  } catch {
    return { ready: false, runningExperiments: 0, completedExperiments: 0, warning: "Experiment Tracking is not reachable." };
  }
}

async function safeDataFreshnessSummary(sellerId: string): Promise<{
  ready: boolean;
  staleDataSources: number;
  topRisks: unknown[];
  warning: string | null;
}> {
  try {
    const summary = await getDataFreshnessSummary(sellerId);
    const criticalSources = getCriticalDataSourceSet();
    return {
      ready: true,
      staleDataSources: summary.staleSources,
      topRisks: summary.rows
        .filter((row) => (row.status === "STALE" || row.status === "ERROR") && criticalSources.has(row.dataSource))
        .slice(0, 5),
      warning: summary.warnings[0] ?? null
    };
  } catch {
    return { ready: false, staleDataSources: 0, topRisks: [], warning: "Data Freshness is not reachable." };
  }
}

async function safeAiCostSummary(sellerId: string): Promise<{
  ready: boolean;
  aiCostToday: number;
  aiCostMonth: number;
  warning: string | null;
}> {
  try {
    const summary = await getAiCostSummary(sellerId);
    return {
      ready: true,
      aiCostToday: summary.estimatedCostToday,
      aiCostMonth: summary.estimatedCostMonth,
      warning: null
    };
  } catch {
    return { ready: false, aiCostToday: 0, aiCostMonth: 0, warning: "AI Gateway is not reachable." };
  }
}

async function safeSafetyControlReady(sellerId: string): Promise<{ ready: boolean; warning: string | null }> {
  const snapshot = await getSafetyControlSnapshotSafe(sellerId);
  return {
    ready: Boolean(snapshot.settings),
    warning: snapshot.settings ? null : "Safety Control is using locked fallback settings."
  };
}

async function safeProductionHealthReady(sellerId: string): Promise<{ ready: boolean; warning: string | null }> {
  try {
    const summary = await getProductionHealthSummary(sellerId);
    return {
      ready: true,
      warning: summary.overallStatus === "PASS" ? null : `Production Health is ${summary.overallStatus}.`
    };
  } catch {
    return { ready: false, warning: "Production Health is not reachable." };
  }
}

export async function getTodayCommandSummary(sellerIdInput: string): Promise<TodayCommandSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const warnings: string[] = [];
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    actionSummary,
    priorities,
    engineSummary,
    productPassportCount,
    productEconomicsCount,
    dailyOrchestratorCount,
    learningEventCount,
    enginesTrackedCount,
    executionAttemptCount,
    shadowExecutionCount,
    listingDraftCount,
    creativeRecommendationCount,
    safetyControl,
    alertSummary,
    experimentSummary,
    dataFreshnessSummary,
    aiCostSummary,
    productionHealth
  ] = await Promise.all([
    safeActionSummary(sellerId),
    safePriorities(sellerId),
    safeEngineSummary(sellerId),
    safeCount({ table: "product_passports", sellerId }),
    safeCount({ table: "amazon_product_economics", sellerId }),
    safeCount({ table: "daily_orchestrator_runs", sellerId }),
    safeCount({ table: "action_learning_events", sellerId }),
    safeCount({ table: "engine_learning_summary", sellerId }),
    safeCount({ table: "execution_attempts", sellerId }),
    safeCount({ table: "execution_attempts", sellerId, filters: [{ column: "execution_status", value: "SHADOW_COMPLETED" }] }),
    safeCount({ table: "listing_optimization_drafts", sellerId }),
    safeCount({ table: "creative_recommendations", sellerId }),
    safeSafetyControlReady(sellerId),
    safeAlertSummary(sellerId),
    safeExperimentSummary(sellerId),
    safeDataFreshnessSummary(sellerId),
    safeAiCostSummary(sellerId),
    safeProductionHealthReady(sellerId)
  ]);

  for (const warning of [
    actionSummary.warning,
    priorities.warning,
    engineSummary.warning,
    productPassportCount.warning,
    productEconomicsCount.warning,
    dailyOrchestratorCount.warning,
    learningEventCount.warning,
    enginesTrackedCount.warning,
    executionAttemptCount.warning,
    shadowExecutionCount.warning,
    listingDraftCount.warning,
    creativeRecommendationCount.warning,
    safetyControl.warning,
    alertSummary.warning,
    experimentSummary.warning,
    dataFreshnessSummary.warning,
    aiCostSummary.warning,
    productionHealth.warning
  ]) {
    if (warning) warnings.push(warning);
  }

  const recentActionsCreated = await safeCount({
    table: "action_ledger",
    sellerId,
    sinceColumn: "created_at",
    sinceIso: since
  });
  if (recentActionsCreated.warning) warnings.push(recentActionsCreated.warning);

  const systemStatus: TodayCommandSystemStatus = {
    actionLedgerReady: actionSummary.ready,
    approvalCenterReady: actionSummary.ready,
    engineRegistryReady: engineSummary.ready,
    engineRouterReady: engineSummary.routerReady,
    dailyOrchestratorReady: dailyOrchestratorCount.ready,
    productPassportReady: productPassportCount.ready,
    productEconomicsReady: productEconomicsCount.ready,
    learningLoopReady: learningEventCount.ready && enginesTrackedCount.ready,
    executionGatewayReady: executionAttemptCount.ready,
    safetyControlReady: safetyControl.ready,
    alertCenterReady: alertSummary.ready,
    experimentsReady: experimentSummary.ready,
    dataFreshnessReady: dataFreshnessSummary.ready,
    aiGatewayReady: aiCostSummary.ready,
    productionHealthReady: productionHealth.ready
  };

  const counts: TodayCommandCounts = {
    pendingApprovals: actionSummary.pending,
    approvedActions: actionSummary.approved,
    completedActions: actionSummary.completed,
    rejectedActions: actionSummary.rejected,
    totalEngines: engineSummary.totalEngines,
    enabledEngines: engineSummary.enabledEngines,
    last24hEngineRuns: engineSummary.last24hRuns,
    last24hActionsCreated: Math.max(engineSummary.last24hActionsCreated, recentActionsCreated.count),
    totalLearningEvents: learningEventCount.count,
    enginesTracked: enginesTrackedCount.count,
    executionAttempts: executionAttemptCount.count,
    shadowExecutions: shadowExecutionCount.count,
    listingDrafts: listingDraftCount.count,
    creativeRecommendations: creativeRecommendationCount.count,
    openAlerts: alertSummary.openAlerts,
    highAlerts: alertSummary.highAlerts,
    runningExperiments: experimentSummary.runningExperiments,
    completedExperiments: experimentSummary.completedExperiments,
    staleDataSources: dataFreshnessSummary.staleDataSources,
    aiCostToday: aiCostSummary.aiCostToday,
    aiCostMonth: aiCostSummary.aiCostMonth
  };

  const failedReadiness = Object.entries(systemStatus)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);

  return {
    ok: true,
    sellerId,
    mode: "SHADOW",
    systemStatus,
    counts,
    topRisks: [
      ...alertSummary.topRisks,
      ...dataFreshnessSummary.topRisks,
      ...actionSummary.topRisks
    ].slice(0, 12),
    todayPriorities: priorities.rows,
    nextBestActions: buildNextBestActions({
      pendingApprovals: counts.pendingApprovals,
      listingDrafts: counts.listingDrafts,
      creativeRecommendations: counts.creativeRecommendations,
      openAlerts: counts.highAlerts,
      staleDataSources: counts.staleDataSources,
      runningExperiments: counts.runningExperiments,
      failedReadiness
    }),
    safety: {
      shadowMode: true,
      externalExecution: false,
      liveExecutionEnabled: false,
      aiCallsEnabled: false
    },
    warnings: [...new Set(warnings)]
  };
}
