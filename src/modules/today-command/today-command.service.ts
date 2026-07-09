import { supabase } from "../../db/supabase";
import { getActionLedgerSummary, getDailyPriorities } from "../action-ledger/action-ledger.service";
import { getEngineRouterSummary } from "../engine-router/engine-router.service";
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
  failedReadiness: string[];
}): string[] {
  const actions: string[] = [];

  if (input.pendingApprovals > 0) actions.push("Review pending approval actions.");
  if (input.listingDrafts > 0) actions.push("Review listing optimization drafts awaiting approval.");
  if (input.creativeRecommendations > 0) actions.push("Review image and A+ recommendations awaiting approval.");
  if (input.failedReadiness.length > 0) actions.push("Resolve backend readiness warnings before expanding automation.");
  actions.push("Keep all marketplace actions in shadow mode.");

  return [...new Set(actions)].slice(0, 8);
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
    creativeRecommendationCount
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
    safeCount({ table: "creative_recommendations", sellerId })
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
    creativeRecommendationCount.warning
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
    executionGatewayReady: executionAttemptCount.ready
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
    creativeRecommendations: creativeRecommendationCount.count
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
    topRisks: actionSummary.topRisks,
    todayPriorities: priorities.rows,
    nextBestActions: buildNextBestActions({
      pendingApprovals: counts.pendingApprovals,
      listingDrafts: counts.listingDrafts,
      creativeRecommendations: counts.creativeRecommendations,
      failedReadiness
    }),
    safety: {
      shadowMode: true,
      externalExecution: false,
      liveExecutionEnabled: false
    },
    warnings: [...new Set(warnings)]
  };
}
