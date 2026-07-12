import { supabase } from "../../db/supabase";
import { getActionLedgerSummary } from "../action-ledger/action-ledger.service";
import { getActivityLogSummary, safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { generateAiResponse, getAiGatewayStatus } from "../ai-gateway/ai-gateway.service";
import { getAlertSummary } from "../alert-center/alert-center.service";
import { getDataFreshnessSummary } from "../data-freshness/data-freshness.service";
import { getDailyOrchestratorStatus } from "../daily-orchestrator/daily-orchestrator.service";
import { getEngineRouterSummary } from "../engine-router/engine-router.service";
import { getEngineRegistrySummary } from "../engine-registry/engine-registry.service";
import { getExecutionGatewayStatus } from "../execution-gateway/execution-gateway.service";
import { getExperimentSummary } from "../experiments/experiments.service";
import { getLaunchChecklistSummary } from "../launch-checklist/launch-checklist.service";
import { getLaunchGateSummary } from "../launch-gate/launch-gate.service";
import { getLiveExecutionStatus } from "../live-execution/live-execution.service";
import { getNotificationOutboxSummary } from "../notification-outbox/notification-outbox.service";
import { getSchedulerControlSummary } from "../scheduler-control/scheduler-control.service";
import { getSecurityGuardrailsSummary } from "../security-guardrails/security-guardrails.service";
import { listEngineLearningSummaries } from "../learning-loop/learning-loop.service";
import { getListingDraftSummary } from "../listing-drafts/listing-drafts.service";
import { getCreativeRecommendationSummary } from "../creative-recommendations/creative-recommendations.service";
import { getMaintenanceSummary } from "../maintenance/maintenance.service";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { getRollbackSummary } from "../rollback/rollback.service";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { getTodayCommandSummary } from "../today-command/today-command.service";
import { QaSmokeCheck, QaSmokeCheckStatus, QaSmokeRunRow, SafeQaSmokeRun } from "./qa-smoke.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toSafeRun(row: QaSmokeRunRow): SafeQaSmokeRun {
  return {
    id: row.id,
    sellerId: row.seller_id,
    runStatus: row.run_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalChecks: toNumber(row.total_checks),
    passCount: toNumber(row.pass_count),
    warnCount: toNumber(row.warn_count),
    failCount: toNumber(row.fail_count),
    checks: toArray<QaSmokeCheck>(row.checks),
    blockers: toArray(row.blockers),
    warnings: toArray(row.warnings),
    createdAt: row.created_at
  };
}

async function createRun(sellerId: string): Promise<SafeQaSmokeRun> {
  const { data, error } = await supabase
    .from("qa_smoke_test_runs")
    .insert({ seller_id: sellerId, run_status: "RUNNING" })
    .select("*")
    .single<QaSmokeRunRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not create QA smoke run.");
  return toSafeRun(data);
}

async function updateRun(runId: string, row: Record<string, unknown>): Promise<SafeQaSmokeRun> {
  const { data, error } = await supabase
    .from("qa_smoke_test_runs")
    .update(row)
    .eq("id", runId)
    .select("*")
    .single<QaSmokeRunRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not update QA smoke run.");
  return toSafeRun(data);
}

async function tableReachable(table: string, sellerId?: string): Promise<number> {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (sellerId) query = query.eq("seller_id", sellerId);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function runCheck(input: {
  key: string;
  name: string;
  critical: boolean;
  fn: () => Promise<string | { status?: QaSmokeCheckStatus; message: string }>;
}): Promise<QaSmokeCheck> {
  const started = Date.now();
  try {
    const result = await input.fn();
    const status = typeof result === "string" ? "PASS" : result.status ?? "PASS";
    const message = typeof result === "string" ? result : result.message;
    return {
      key: input.key,
      name: input.name,
      status,
      critical: input.critical,
      message,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      key: input.key,
      name: input.name,
      status: input.critical ? "FAIL" : "WARN",
      critical: input.critical,
      message: error instanceof Error ? error.message : "Check failed safely.",
      durationMs: Date.now() - started
    };
  }
}

export async function runQaSmokeTest(sellerIdInput: string): Promise<{
  ok: boolean;
  sellerId: string;
  runId: string;
  runStatus: string;
  totalChecks: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  checks: QaSmokeCheck[];
  blockers: string[];
  warnings: string[];
  message: string;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const run = await createRun(sellerId);
  const checks = await Promise.all([
    runCheck({ key: "api_server", name: "API server responding", critical: true, fn: async () => "API server service layer is responding." }),
    runCheck({ key: "supabase", name: "Supabase reachable", critical: true, fn: async () => `Supabase reachable with ${await tableReachable("amazon_connections")} connection rows.` }),
    runCheck({ key: "action_ledger", name: "Action Ledger summary reachable", critical: true, fn: async () => { const summary = await getActionLedgerSummary(sellerId); return `Action Ledger reachable with ${summary.pendingCount} pending approvals.`; } }),
    runCheck({ key: "approval_center", name: "Approval Center data reachable", critical: true, fn: async () => { const summary = await getActionLedgerSummary(sellerId); return `Approval Center reachable with ${summary.approvedCount} approved actions.`; } }),
    runCheck({ key: "product_passport", name: "Product Passport summary reachable", critical: true, fn: async () => `Product Passport reachable with ${await tableReachable("product_passports", sellerId)} rows.` }),
    runCheck({ key: "product_economics", name: "Product Economics reachable", critical: true, fn: async () => `Product Economics reachable with ${await tableReachable("amazon_product_economics", sellerId)} rows.` }),
    runCheck({ key: "engine_registry", name: "Engine Registry summary reachable", critical: true, fn: async () => { const summary = await getEngineRegistrySummary(); return summary.totalEngines >= 300 ? `Engine Registry has ${summary.totalEngines} engines.` : { status: "WARN", message: `Engine Registry has ${summary.totalEngines} engines, below 300.` }; } }),
    runCheck({ key: "engine_router", name: "Engine Router summary reachable", critical: true, fn: async () => { const summary = await getEngineRouterSummary(sellerId); return `Engine Router reachable with ${summary.last24hRuns} runs in 24h.`; } }),
    runCheck({ key: "daily_orchestrator", name: "Daily Orchestrator status reachable", critical: false, fn: async () => { const status = await getDailyOrchestratorStatus(sellerId); return `Daily Orchestrator status is ${status.mode}.`; } }),
    runCheck({ key: "learning_loop", name: "Learning Loop summary reachable", critical: false, fn: async () => `Learning Loop reachable with ${(await listEngineLearningSummaries(sellerId)).length} engine summaries.` }),
    runCheck({ key: "execution_gateway", name: "Execution Gateway status reachable and live blocked", critical: true, fn: async () => { const status = await getExecutionGatewayStatus(sellerId); return status.liveExecutionEnabled === false ? "Execution Gateway live execution is blocked." : { status: "FAIL", message: "Execution Gateway live execution is unexpectedly enabled." }; } }),
    runCheck({ key: "live_execution_status", name: "Live Execution status reachable", critical: true, fn: async () => { const status = await getLiveExecutionStatus(sellerId); return status.liveExecutionEnabled ? { status: "WARN", message: "Live execution flag is enabled; preflight gates still apply." } : "Live Execution status reachable and OFF by default."; } }),
    runCheck({ key: "launch_gate_summary", name: "Launch Gate summary reachable", critical: false, fn: async () => { const summary = await getLaunchGateSummary(sellerId); return `Launch Gate is ${summary.overallStatus}.`; } }),
    runCheck({ key: "scheduler_control_summary", name: "Scheduler Control summary reachable", critical: false, fn: async () => { const summary = await getSchedulerControlSummary(sellerId); return `Scheduler Control reachable with ${summary.totalJobs} jobs.`; } }),
    runCheck({ key: "notification_outbox_summary", name: "Notification Outbox summary reachable", critical: false, fn: async () => { const summary = await getNotificationOutboxSummary(sellerId); return `Notification Outbox reachable with ${summary.queuedCount} queued messages.`; } }),
    runCheck({ key: "security_guardrails_summary", name: "Security Guardrails summary reachable", critical: false, fn: async () => { const summary = await getSecurityGuardrailsSummary(sellerId); return `Security Guardrails reachable with ${summary.blockedEvents} blocked events.`; } }),
    runCheck({ key: "launch_checklist_summary", name: "Launch Checklist summary reachable", critical: false, fn: async () => { const summary = await getLaunchChecklistSummary(sellerId); return `Launch Checklist is ${summary.overallLaunchStatus}.`; } }),
    runCheck({ key: "listing_drafts", name: "Listing Drafts summary reachable", critical: false, fn: async () => { const summary = await getListingDraftSummary(sellerId); return `Listing Drafts reachable with ${summary.totalDrafts} drafts.`; } }),
    runCheck({ key: "creative_recommendations", name: "Creative Recommendations summary reachable", critical: false, fn: async () => { const summary = await getCreativeRecommendationSummary(sellerId); return `Creative Recommendations reachable with ${summary.totalRecommendations} recommendations.`; } }),
    runCheck({ key: "safety_control", name: "Safety Control status reachable", critical: true, fn: async () => { const snapshot = await getSafetyControlSnapshotSafe(sellerId); return snapshot.settings ? "Safety Control is initialized and guarded." : { status: "FAIL", message: "Safety Control is missing." }; } }),
    runCheck({ key: "alert_center", name: "Alert Center summary reachable", critical: false, fn: async () => { const summary = await getAlertSummary(sellerId); return `Alert Center reachable with ${summary.openAlerts} open alerts.`; } }),
    runCheck({ key: "experiments", name: "Experiments summary reachable", critical: false, fn: async () => { const summary = await getExperimentSummary(sellerId); return `Experiments reachable with ${summary.runningExperiments} running experiments.`; } }),
    runCheck({ key: "data_freshness", name: "Data Freshness summary reachable", critical: true, fn: async () => { const summary = await getDataFreshnessSummary(sellerId); return `Data Freshness reachable with ${summary.freshSources}/${summary.totalSources} fresh sources.`; } }),
    runCheck({ key: "ai_gateway", name: "AI Gateway status reachable and AI disabled", critical: true, fn: async () => { const status = await getAiGatewayStatus(sellerId); return status.aiCallsEnabled === false ? "AI Gateway is disabled." : { status: "FAIL", message: "AI Gateway is unexpectedly enabled." }; } }),
    runCheck({ key: "ai_gateway_generate_blocked", name: "AI Gateway generate blocks when disabled", critical: true, fn: async () => { const result = await generateAiResponse({ sellerId, moduleName: "CEO_REPORT", purpose: "qa_smoke", prompt: "health check" }); return result.ok === false && result.blockedReason ? `AI generate blocked with ${result.blockedReason}.` : { status: "FAIL", message: "AI generate was not blocked." }; } }),
    runCheck({ key: "production_health", name: "Production Health summary reachable", critical: true, fn: async () => { const summary = await getProductionHealthSummary(sellerId); return `Production Health is ${summary.overallStatus}.`; } }),
    runCheck({ key: "today_command", name: "Today Command summary reachable", critical: true, fn: async () => { const summary = await getTodayCommandSummary(sellerId); return summary.ok ? "Today Command returned ok true." : { status: "FAIL", message: "Today Command did not return ok true." }; } }),
    runCheck({ key: "activity_logs", name: "Activity Logs reachable", critical: false, fn: async () => { const summary = await getActivityLogSummary(sellerId); return `Activity Logs reachable with ${summary.totalEvents} events.`; } }),
    runCheck({ key: "rollback", name: "Rollback reachable", critical: false, fn: async () => { const summary = await getRollbackSummary(sellerId); return `Rollback reachable with ${summary.totalSnapshots} snapshots.`; } }),
    runCheck({ key: "maintenance", name: "Maintenance reachable", critical: false, fn: async () => { const summary = await getMaintenanceSummary(sellerId); return `Maintenance reachable with ${summary.totalRuns} runs.`; } })
  ]);

  const passCount = checks.filter((check) => check.status === "PASS").length;
  const warnCount = checks.filter((check) => check.status === "WARN").length;
  const failCount = checks.filter((check) => check.status === "FAIL").length;
  const blockers = checks.filter((check) => check.critical && check.status === "FAIL").map((check) => `${check.name}: ${check.message}`);
  const warnings = checks.filter((check) => check.status === "WARN").map((check) => `${check.name}: ${check.message}`);
  const runStatus = blockers.length > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS";
  const updated = await updateRun(run.id, {
    run_status: runStatus,
    finished_at: new Date().toISOString(),
    total_checks: checks.length,
    pass_count: passCount,
    warn_count: warnCount,
    fail_count: failCount,
    checks,
    blockers,
    warnings
  });

  await safeRecordActivityLog({
    sellerId,
    eventType: "QA_SMOKE_TEST_COMPLETED",
    eventCategory: "QA",
    severity: runStatus === "PASS" ? "SUCCESS" : runStatus === "WARN" ? "WARNING" : "ERROR",
    actor: "qa-smoke",
    title: "QA smoke test completed",
    message: `QA smoke test completed with status ${runStatus}.`,
    sourceModule: "qa-smoke",
    metadata: { runId: updated.id, passCount, warnCount, failCount }
  });

  return {
    ok: blockers.length === 0,
    sellerId,
    runId: updated.id,
    runStatus: updated.runStatus,
    totalChecks: updated.totalChecks,
    passCount: updated.passCount,
    warnCount: updated.warnCount,
    failCount: updated.failCount,
    checks: updated.checks,
    blockers: blockers,
    warnings,
    message: `QA smoke test completed with status ${runStatus}. No external action executed.`
  };
}

export async function listQaSmokeRuns(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeQaSmokeRun[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 50);
  const { data, error } = await supabase
    .from("qa_smoke_test_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return ((data ?? []) as QaSmokeRunRow[]).map(toSafeRun);
}

export async function getLatestQaSmokeRun(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  latestRun: SafeQaSmokeRun | null;
  latestStatus: string | null;
  message: string;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const rows = await listQaSmokeRuns({ sellerId, limit: 1 });
  return {
    ok: true,
    sellerId,
    latestRun: rows[0] ?? null,
    latestStatus: rows[0]?.runStatus ?? null,
    message: "QA Smoke Runner is available. Checks are shadow-mode only."
  };
}
