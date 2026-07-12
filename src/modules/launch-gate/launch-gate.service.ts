import { supabase } from "../../db/supabase";
import { getActionLedgerSummary } from "../action-ledger/action-ledger.service";
import { getActivityLogSummary } from "../activity-logs/activity-logs.service";
import { getAiGatewayStatus } from "../ai-gateway/ai-gateway.service";
import { getAlertSummary } from "../alert-center/alert-center.service";
import { getDataFreshnessSummary } from "../data-freshness/data-freshness.service";
import { getExecutionGatewayStatus } from "../execution-gateway/execution-gateway.service";
import { getLiveExecutionStatus } from "../live-execution/live-execution.service";
import { getListingLiveAdapterStatus } from "../live-execution/listing-live-adapter";
import { getPpcLiveAdapterStatus } from "../live-execution/ppc-live-adapter";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { LaunchGateCheckRow, LaunchGateSummary, SafeLaunchGateCheck } from "./launch-gate.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSafeCheck(row: LaunchGateCheckRow): SafeLaunchGateCheck {
  return {
    id: row.id,
    sellerId: row.seller_id,
    checkKey: row.check_key,
    checkName: row.check_name,
    status: row.status,
    severity: row.severity,
    message: row.message,
    metadata: toJsonObject(row.metadata),
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function safeCount(input: {
  table: string;
  sellerId?: string;
  filters?: Array<{ column: string; value: string | number | boolean }>;
  sinceColumn?: string;
  sinceIso?: string;
}): Promise<number> {
  let query = supabase.from(input.table).select("id", { count: "exact", head: true });
  if (input.sellerId) query = query.eq("seller_id", input.sellerId);
  for (const filter of input.filters ?? []) query = query.eq(filter.column, filter.value);
  if (input.sinceColumn && input.sinceIso) query = query.gte(input.sinceColumn, input.sinceIso);
  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

function makeCheck(input: {
  key: string;
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message: string;
  metadata?: Record<string, unknown>;
}): Omit<LaunchGateCheckRow, "id" | "created_at" | "updated_at"> {
  return {
    seller_id: "default",
    check_key: input.key,
    check_name: input.name,
    status: input.status,
    severity: input.severity ?? (input.status === "FAIL" ? "HIGH" : "LOW"),
    message: input.message,
    metadata: input.metadata ?? {},
    last_checked_at: new Date().toISOString()
  };
}

async function recentPassQa(sellerId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return (await safeCount({ table: "qa_smoke_test_runs", sellerId, filters: [{ column: "run_status", value: "PASS" }], sinceColumn: "started_at", sinceIso: since })) > 0;
}

async function recentMaintenance(sellerId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return (await safeCount({ table: "maintenance_runs", sellerId, sinceColumn: "started_at", sinceIso: since })) > 0;
}

async function buildChecks(sellerId: string): Promise<Array<Omit<LaunchGateCheckRow, "id" | "created_at" | "updated_at">>> {
  const checks: Array<Omit<LaunchGateCheckRow, "id" | "created_at" | "updated_at">> = [];
  const safety = await getSafetyControlSnapshotSafe(sellerId);
  const liveStatus = await getLiveExecutionStatus(sellerId).catch(() => null);
  const aiStatus = await getAiGatewayStatus(sellerId).catch(() => null);
  const ppcAdapter = getPpcLiveAdapterStatus();
  const listingAdapter = getListingLiveAdapterStatus();

  checks.push(makeCheck({ key: "safety_control_initialized", name: "Safety Control initialized", status: safety.settings ? "PASS" : "FAIL", severity: "CRITICAL", message: safety.settings ? "Safety Control initialized." : "Safety Control missing." }));
  checks.push(makeCheck({ key: "live_execution_default_off", name: "Live execution default OFF", status: liveStatus?.liveExecutionEnabled ? "WARN" : "PASS", severity: "HIGH", message: liveStatus?.liveExecutionEnabled ? "Live execution is enabled; ensure controlled launch only." : "Live execution is OFF." }));
  checks.push(makeCheck({ key: "ppc_live_flag", name: "PPC live flag status", status: liveStatus?.ppcLiveExecutionEnabled ? "WARN" : "PASS", severity: "HIGH", message: liveStatus?.ppcLiveExecutionEnabled ? "PPC live flag is enabled." : "PPC live flag is OFF." }));
  checks.push(makeCheck({ key: "listing_live_flag", name: "Listing live flag status", status: liveStatus?.listingLiveExecutionEnabled ? "WARN" : "PASS", severity: "HIGH", message: liveStatus?.listingLiveExecutionEnabled ? "Listing live flag is enabled." : "Listing live flag is OFF." }));
  checks.push(makeCheck({ key: "ai_calls_flag", name: "AI calls flag status", status: aiStatus?.aiCallsEnabled ? "WARN" : "PASS", severity: "HIGH", message: aiStatus?.aiCallsEnabled ? "AI calls are enabled." : "AI calls are OFF." }));
  checks.push(makeCheck({ key: "qa_smoke_recent_pass", name: "QA Smoke PASS within 24h", status: await recentPassQa(sellerId) ? "PASS" : "FAIL", severity: "CRITICAL", message: "QA Smoke must PASS within 24 hours." }));
  checks.push(makeCheck({ key: "maintenance_recent", name: "Maintenance run within 24h", status: await recentMaintenance(sellerId) ? "PASS" : "WARN", severity: "MEDIUM", message: "Maintenance should run within 24 hours." }));

  await getProductionHealthSummary(sellerId).then((summary) => checks.push(makeCheck({
    key: "production_health_no_blockers",
    name: "Production Health no blockers",
    status: summary.blockers.length ? "FAIL" : "PASS",
    severity: "CRITICAL",
    message: summary.blockers.length ? "Production Health has blockers." : "Production Health has no blockers.",
    metadata: { blockers: summary.blockers }
  }))).catch(() => checks.push(makeCheck({ key: "production_health_no_blockers", name: "Production Health no blockers", status: "FAIL", severity: "CRITICAL", message: "Production Health unavailable." })));

  await getDataFreshnessSummary(sellerId).then((summary) => checks.push(makeCheck({
    key: "data_freshness_acceptable",
    name: "Data Freshness acceptable",
    status: summary.errorSources > 0 ? "FAIL" : summary.staleSources > 0 || summary.unknownSources > 0 ? "WARN" : "PASS",
    severity: "HIGH",
    message: `${summary.freshSources}/${summary.totalSources} sources fresh.`,
    metadata: { staleSources: summary.staleSources, errorSources: summary.errorSources, unknownSources: summary.unknownSources }
  }))).catch(() => checks.push(makeCheck({ key: "data_freshness_acceptable", name: "Data Freshness acceptable", status: "FAIL", severity: "HIGH", message: "Data Freshness unavailable." })));

  await getActionLedgerSummary(sellerId).then((summary) => checks.push(makeCheck({
    key: "approval_backlog_reviewed",
    name: "Approval backlog reviewed",
    status: summary.pendingCount > 50 ? "WARN" : "PASS",
    severity: "MEDIUM",
    message: `${summary.pendingCount} approvals pending.`
  }))).catch(() => checks.push(makeCheck({ key: "approval_backlog_reviewed", name: "Approval backlog reviewed", status: "WARN", severity: "MEDIUM", message: "Approval backlog unavailable." })));

  checks.push(makeCheck({ key: "rollback_snapshots_available", name: "Rollback snapshots available", status: (await safeCount({ table: "rollback_snapshots", sellerId })) > 0 ? "PASS" : "WARN", severity: "HIGH", message: "Rollback snapshots should exist for ready actions." }));
  await getActivityLogSummary(sellerId).then((summary) => checks.push(makeCheck({ key: "activity_logs_working", name: "Activity logs working", status: "PASS", message: `${summary.totalEvents} activity events.` }))).catch(() => checks.push(makeCheck({ key: "activity_logs_working", name: "Activity logs working", status: "FAIL", severity: "HIGH", message: "Activity logs unavailable." })));
  checks.push(makeCheck({ key: "learning_loop_working", name: "Learning loop working", status: (await safeCount({ table: "action_learning_events", sellerId })) > 0 ? "PASS" : "WARN", severity: "MEDIUM", message: "Learning Loop should have events." }));
  await getExecutionGatewayStatus(sellerId).then((status) => checks.push(makeCheck({ key: "execution_gateway_working", name: "Execution gateway working", status: status.liveExecutionEnabled ? "FAIL" : "PASS", severity: "HIGH", message: "Execution Gateway is reachable and live-blocking." }))).catch(() => checks.push(makeCheck({ key: "execution_gateway_working", name: "Execution gateway working", status: "FAIL", severity: "HIGH", message: "Execution Gateway unavailable." })));
  checks.push(makeCheck({ key: "ads_mutation_client", name: "Amazon Ads mutation client configured if PPC live requested", status: liveStatus?.ppcLiveExecutionEnabled && !ppcAdapter.configured ? "FAIL" : "PASS", severity: "CRITICAL", message: ppcAdapter.reason }));
  checks.push(makeCheck({ key: "listing_mutation_client", name: "SP-API listing mutation client configured if listing live requested", status: liveStatus?.listingLiveExecutionEnabled && !listingAdapter.configured ? "FAIL" : "PASS", severity: "CRITICAL", message: listingAdapter.reason }));
  checks.push(makeCheck({ key: "cost_data_completion", name: "Cost data completion above threshold", status: (await safeCount({ table: "action_ledger", sellerId, filters: [{ column: "action_type", value: "COST_DATA_REQUIRED" }, { column: "approval_status", value: "PENDING" }] })) > 0 ? "WARN" : "PASS", severity: "MEDIUM", message: "Cost data completion checked." }));
  checks.push(makeCheck({ key: "product_economics_availability", name: "Product economics availability above threshold", status: (await safeCount({ table: "amazon_product_economics", sellerId })) > 0 ? "PASS" : "WARN", severity: "HIGH", message: "Product economics rows should be available." }));
  await getAlertSummary(sellerId).then((summary) => checks.push(makeCheck({ key: "high_severity_alerts_reviewed", name: "High severity alerts reviewed", status: summary.highAlerts + summary.criticalAlerts > 0 ? "WARN" : "PASS", severity: "HIGH", message: `${summary.highAlerts + summary.criticalAlerts} high/critical alerts open.` }))).catch(() => checks.push(makeCheck({ key: "high_severity_alerts_reviewed", name: "High severity alerts reviewed", status: "WARN", severity: "HIGH", message: "Alert Center unavailable." })));

  return checks.map((item) => ({ ...item, seller_id: sellerId }));
}

async function upsertChecks(sellerId: string, checks: Array<Omit<LaunchGateCheckRow, "id" | "created_at" | "updated_at">>): Promise<SafeLaunchGateCheck[]> {
  const { data, error } = await supabase
    .from("launch_gate_checks")
    .upsert(checks.map((row) => ({ ...row, seller_id: sellerId, updated_at: new Date().toISOString() })), { onConflict: "seller_id,check_key" })
    .select("*");
  if (error) throw new Error(error.message);
  return ((data ?? []) as LaunchGateCheckRow[]).map(toSafeCheck);
}

function summarize(sellerId: string, checks: SafeLaunchGateCheck[]): LaunchGateSummary {
  const blockers = checks.filter((check) => check.status === "FAIL" && (check.severity === "HIGH" || check.severity === "CRITICAL")).map((check) => `${check.checkName}: ${check.message}`);
  const warnings = checks.filter((check) => check.status === "WARN").map((check) => `${check.checkName}: ${check.message}`);
  const overallStatus = blockers.length ? "FAIL" : warnings.length ? "WARN" : "PASS";
  const ppcLiveEligible = !blockers.length && !checks.some((check) => check.checkKey === "ads_mutation_client" && check.status === "FAIL");
  const listingLiveEligible = !blockers.length && !checks.some((check) => check.checkKey === "listing_mutation_client" && check.status === "FAIL");
  return {
    ok: blockers.length === 0,
    sellerId,
    overallStatus,
    liveEligible: blockers.length === 0,
    ppcLiveEligible,
    listingLiveEligible,
    blockers,
    warnings,
    nextSteps: [
      ...(blockers.length ? ["Resolve launch gate blockers before any live execution."] : []),
      ...(warnings.length ? ["Review launch gate warnings and document accepted risk."] : []),
      "Run QA smoke and maintenance before limited live tests.",
      "Keep adapters marked not configured until real mutation clients are verified."
    ],
    checks
  };
}

export async function runLaunchGateChecks(sellerIdInput: string): Promise<LaunchGateSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const checks = await upsertChecks(sellerId, await buildChecks(sellerId));
  return summarize(sellerId, checks);
}

export async function getLaunchGateSummary(sellerIdInput: string): Promise<LaunchGateSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("launch_gate_checks")
    .select("*")
    .eq("seller_id", sellerId)
    .order("last_checked_at", { ascending: false });
  if (error) return runLaunchGateChecks(sellerId);
  const rows = ((data ?? []) as LaunchGateCheckRow[]).map(toSafeCheck);
  return rows.length ? summarize(sellerId, rows) : runLaunchGateChecks(sellerId);
}
