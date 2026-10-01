import { supabase } from "../../db/supabase";
import { getActionLedgerSummary } from "../action-ledger/action-ledger.service";
import { getAlertSummary } from "../alert-center/alert-center.service";
import { getAiCostSummary, getAiGatewayStatus } from "../ai-gateway/ai-gateway.service";
import { getDataFreshnessSummary } from "../data-freshness/data-freshness.service";
import { getExperimentSummary } from "../experiments/experiments.service";
import { getExecutionGatewayStatus } from "../execution-gateway/execution-gateway.service";
import { getListingLiveAdapterStatus } from "../live-execution/listing-live-adapter";
import { getPpcLiveAdapterStatus } from "../live-execution/ppc-live-adapter";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { ProductionHealthModule, ProductionHealthStatus, ProductionHealthSummary } from "./production-health.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

async function safeCount(input: {
  table: string;
  sellerId?: string;
  filters?: Array<{ column: string; value: string | number | boolean }>;
}): Promise<{ count: number; error: string | null }> {
  let query = supabase.from(input.table).select("id", { count: "exact", head: true });
  if (input.sellerId) query = query.eq("seller_id", input.sellerId);
  for (const filter of input.filters ?? []) query = query.eq(filter.column, filter.value);
  const { count, error } = await query;
  return { count: count ?? 0, error: error?.message ?? null };
}

function moduleResult(input: {
  key: string;
  name: string;
  status: ProductionHealthStatus;
  message: string;
  critical: boolean;
  counts?: Record<string, number>;
}): ProductionHealthModule {
  return {
    key: input.key,
    name: input.name,
    status: input.status,
    message: input.message,
    critical: input.critical,
    counts: input.counts ?? {},
    lastCheckedAt: new Date().toISOString()
  };
}

async function tableModule(input: {
  key: string;
  name: string;
  table: string;
  sellerId?: string;
  critical: boolean;
  emptyWarn?: boolean;
}): Promise<ProductionHealthModule> {
  const result = await safeCount({ table: input.table, sellerId: input.sellerId });
  if (result.error) {
    return moduleResult({
      key: input.key,
      name: input.name,
      critical: input.critical,
      status: input.critical ? "FAIL" : "WARN",
      message: `${input.name} is not reachable.`,
      counts: { rows: 0 }
    });
  }

  const status: ProductionHealthStatus = input.emptyWarn && result.count === 0 ? "WARN" : "PASS";
  return moduleResult({
    key: input.key,
    name: input.name,
    critical: input.critical,
    status,
    message: status === "PASS" ? `${input.name} is reachable.` : `${input.name} has no rows yet.`,
    counts: { rows: result.count }
  });
}

async function recentCount(input: {
  table: string;
  sellerId: string;
  timestampColumn: string;
  sinceIso: string;
}): Promise<number> {
  const { count, error } = await supabase
    .from(input.table)
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId)
    .gte(input.timestampColumn, input.sinceIso);
  if (error) return 0;
  return count ?? 0;
}

export async function getProductionHealthSummary(sellerIdInput: string): Promise<ProductionHealthSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const modules: ProductionHealthModule[] = [
    moduleResult({ key: "api_server", name: "API server", status: "PASS", message: "API server is responding.", critical: true }),
    // The table checks are independent, so run them together instead of one after another.
    ...(await Promise.all([
      tableModule({ key: "supabase_connection", name: "Supabase connection", table: "amazon_connections", critical: true }),
      tableModule({ key: "action_ledger", name: "Action Ledger", table: "action_ledger", sellerId, critical: true }),
      tableModule({ key: "approval_center", name: "Approval Center", table: "action_ledger", sellerId, critical: true }),
      tableModule({ key: "product_passport", name: "Product Passport", table: "product_passports", sellerId, critical: true }),
      tableModule({ key: "product_economics", name: "Product Economics", table: "amazon_product_economics", sellerId, critical: true }),
      tableModule({ key: "amazon_sp_api", name: "Amazon SP-API data availability", table: "amazon_sp_listings", sellerId, critical: true, emptyWarn: true }),
      tableModule({ key: "amazon_ads", name: "Amazon Ads data availability", table: "amazon_ads_campaigns", sellerId, critical: false, emptyWarn: true }),
      tableModule({ key: "engine_registry", name: "Engine Registry", table: "engine_registry", critical: true }),
      tableModule({ key: "engine_router", name: "Engine Router", table: "engine_run_logs", sellerId, critical: true }),
      tableModule({ key: "daily_orchestrator", name: "Daily Orchestrator", table: "daily_orchestrator_runs", sellerId, critical: false }),
      tableModule({ key: "learning_loop", name: "Learning Loop", table: "action_learning_events", sellerId, critical: false }),
      tableModule({ key: "execution_gateway", name: "Execution Gateway", table: "execution_attempts", sellerId, critical: true }),
      tableModule({ key: "live_execution", name: "Live Execution", table: "live_execution_runs", sellerId, critical: true }),
      tableModule({ key: "launch_gate", name: "Launch Gate", table: "launch_gate_checks", sellerId, critical: false }),
      tableModule({ key: "scheduler_control", name: "Scheduler Control", table: "scheduler_jobs", sellerId, critical: false }),
      tableModule({ key: "notification_outbox", name: "Notification Outbox", table: "notification_outbox", sellerId, critical: false }),
      tableModule({ key: "security_guardrails", name: "Security Guardrails", table: "security_audit_events", sellerId, critical: false }),
      tableModule({ key: "listing_drafts", name: "Listing Drafts", table: "listing_optimization_drafts", sellerId, critical: false }),
      tableModule({ key: "creative_recommendations", name: "Creative Recommendations", table: "creative_recommendations", sellerId, critical: false }),
      tableModule({ key: "activity_logs", name: "Activity Logs", table: "activity_log_events", sellerId, critical: false }),
      tableModule({ key: "rollback", name: "Rollback Snapshots", table: "rollback_snapshots", sellerId, critical: false }),
      tableModule({ key: "approval_execution", name: "Approval Execution Bridge", table: "action_ledger", sellerId, critical: true }),
      tableModule({ key: "maintenance", name: "Maintenance Runner", table: "maintenance_runs", sellerId, critical: false }),
      tableModule({ key: "qa_smoke", name: "QA Smoke Tests", table: "qa_smoke_test_runs", sellerId, critical: false })
    ]))
  ];

  const safety = await getSafetyControlSnapshotSafe(sellerId);
  modules.push(moduleResult({
    key: "safety_control",
    name: "Safety Control",
    status: safety.settings ? "PASS" : "WARN",
    message: safety.settings ? "Safety Control is initialized with controlled flags." : "Safety Control table is unavailable or not initialized; locked fallback is active.",
    critical: true
  }));

  const ppcAdapter = getPpcLiveAdapterStatus();
  modules.push(moduleResult({
    key: "ppc_live_adapter",
    name: "PPC live adapter configured status",
    status: safety.settings?.ppcLiveExecutionEnabled && !ppcAdapter.configured ? "FAIL" : "PASS",
    message: ppcAdapter.reason,
    critical: true
  }));

  const listingAdapter = getListingLiveAdapterStatus();
  modules.push(moduleResult({
    key: "listing_live_adapter",
    name: "Listing live adapter configured status",
    status: safety.settings?.listingLiveExecutionEnabled && !listingAdapter.configured ? "FAIL" : "PASS",
    message: listingAdapter.reason,
    critical: true
  }));

  modules.push(moduleResult({
    key: "launch_checklist",
    name: "Launch Checklist",
    status: "PASS",
    message: "Launch Checklist API is mounted; readiness is computed on demand.",
    critical: false
  }));

  await getAlertSummary(sellerId)
    .then((summary) => modules.push(moduleResult({
      key: "alert_center",
      name: "Alert Center",
      status: "PASS",
      message: "Alert Center is reachable.",
      critical: false,
      counts: { openAlerts: summary.openAlerts, highAlerts: summary.highAlerts }
    })))
    .catch(() => modules.push(moduleResult({ key: "alert_center", name: "Alert Center", status: "WARN", message: "Alert Center is not reachable.", critical: false })));

  await getExperimentSummary(sellerId)
    .then((summary) => modules.push(moduleResult({
      key: "experiments",
      name: "Experiments",
      status: "PASS",
      message: "Experiment tracking is reachable.",
      critical: false,
      counts: { runningExperiments: summary.runningExperiments, completedExperiments: summary.completedExperiments }
    })))
    .catch(() => modules.push(moduleResult({ key: "experiments", name: "Experiments", status: "WARN", message: "Experiment tracking is not reachable.", critical: false })));

  await getDataFreshnessSummary(sellerId)
    .then((summary) => modules.push(moduleResult({
      key: "data_freshness",
      name: "Data Freshness",
      status: summary.errorSources > 0 ? "FAIL" : summary.staleSources > 0 || summary.unknownSources > 0 ? "WARN" : "PASS",
      message: `${summary.freshSources}/${summary.totalSources} data sources are fresh.`,
      critical: true,
      counts: { staleSources: summary.staleSources, unknownSources: summary.unknownSources, errorSources: summary.errorSources }
    })))
    .catch(() => modules.push(moduleResult({ key: "data_freshness", name: "Data Freshness", status: "WARN", message: "Data Freshness is not reachable.", critical: true })));

  await Promise.all([
    getAiGatewayStatus(sellerId),
    getAiCostSummary(sellerId)
  ])
    .then(([, cost]) => modules.push(moduleResult({
      key: "ai_gateway",
      name: "AI Gateway",
      status: "PASS",
      message: cost.aiCallsEnabled ? "AI Gateway is reachable and AI calls are controlled by settings." : "AI Gateway is reachable and AI calls are disabled.",
      critical: true,
      counts: { requestsToday: cost.requestsToday, requestsMonth: cost.requestsMonth }
    })))
    .catch(() => modules.push(moduleResult({ key: "ai_gateway", name: "AI Gateway", status: "WARN", message: "AI Gateway is not reachable; AI calls remain disabled.", critical: true })));

  const explicitBlockers: string[] = [];
  const explicitWarnings: string[] = [];
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  if (!safety.settings) {
    explicitBlockers.push("Safety Control is missing and using locked fallback settings.");
  }
  if (safety.liveExecutionEnabled) explicitWarnings.push("Live execution flag is enabled; live runs still require preflight gates.");
  if (safety.aiCallsEnabled) explicitWarnings.push("AI calls flag is enabled; provider and budget guardrails still apply.");

  await getExecutionGatewayStatus(sellerId)
    .then((status) => {
      if (status.liveExecutionEnabled !== false) explicitBlockers.push("Execution Gateway is not blocking live execution.");
    })
    .catch(() => explicitBlockers.push("Execution Gateway live-block status is unavailable."));

  await getAiGatewayStatus(sellerId)
    .then((status) => {
      if (status.aiCallsEnabled) explicitWarnings.push("AI calls are enabled; verify budget and provider guardrails.");
    })
    .catch(() => explicitWarnings.push("AI Gateway status is unavailable; fallback remains disabled."));

  const engineRegistryModule = modules.find((module) => module.key === "engine_registry");
  if ((engineRegistryModule?.counts.rows ?? 0) < 300) {
    explicitBlockers.push("Engine Registry is below 300 engines.");
  }

  if (modules.find((module) => module.key === "supabase_connection")?.status === "FAIL") {
    explicitBlockers.push("Supabase is unreachable.");
  }
  if (modules.find((module) => module.key === "action_ledger")?.status === "FAIL") {
    explicitBlockers.push("Action Ledger is unavailable.");
  }

  await getActionLedgerSummary(sellerId)
    .then((summary) => {
      if (summary.pendingCount >= 50) explicitWarnings.push("High pending approval backlog.");
    })
    .catch(() => explicitWarnings.push("Action Ledger pending approvals could not be checked."));

  await getAlertSummary(sellerId)
    .then((summary) => {
      if (summary.highAlerts + summary.criticalAlerts > 0) explicitWarnings.push("Open critical/high alerts need review.");
    })
    .catch(() => null);

  await getDataFreshnessSummary(sellerId)
    .then((summary) => {
      if (summary.staleSources > 0 || summary.errorSources > 0) explicitWarnings.push("One or more data sources are stale or failing.");
    })
    .catch(() => null);

  const { count: weakEngineCount } = await supabase
    .from("engine_learning_summary")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .lt("usefulness_score", 35);
  if ((weakEngineCount ?? 0) > 0) explicitWarnings.push("Learning Loop has weak engines below usefulness score 35.");

  if ((await recentCount({ table: "qa_smoke_test_runs", sellerId, timestampColumn: "started_at", sinceIso: since24h })) === 0) {
    explicitWarnings.push("No recent QA smoke run in the last 24 hours.");
  }
  if ((await recentCount({ table: "maintenance_runs", sellerId, timestampColumn: "started_at", sinceIso: since24h })) === 0) {
    explicitWarnings.push("No recent maintenance run in the last 24 hours.");
  }

  const blockers = modules.filter((module) => module.critical && module.status === "FAIL").map((module) => module.message);
  blockers.push(...explicitBlockers);
  const warnings = modules.filter((module) => module.status === "WARN").map((module) => module.message);
  warnings.push(...explicitWarnings);
  const overallStatus: ProductionHealthStatus = blockers.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";

  return {
    ok: blockers.length === 0,
    sellerId,
    mode: "SHADOW",
    overallStatus,
    modules,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    nextChecks: [
      "Run data freshness check before daily operating review.",
      "Review open high severity alerts.",
      "Keep live execution blocked until production health is PASS.",
      "Review AI budget before enabling any AI call path."
    ],
    safety: {
      shadowMode: !safety.liveExecutionEnabled,
      externalExecution: false,
      liveExecutionEnabled: safety.liveExecutionEnabled,
      aiCallsEnabled: safety.aiCallsEnabled
    }
  };
}
