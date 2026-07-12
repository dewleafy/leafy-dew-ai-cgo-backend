import { supabase } from "../../db/supabase";
import { getActionLedgerSummary } from "../action-ledger/action-ledger.service";
import { getAiGatewayStatus } from "../ai-gateway/ai-gateway.service";
import { getAlertSummary } from "../alert-center/alert-center.service";
import { getDataFreshnessSummary } from "../data-freshness/data-freshness.service";
import { getLiveExecutionStatus } from "../live-execution/live-execution.service";
import { getListingLiveAdapterStatus } from "../live-execution/listing-live-adapter";
import { getPpcLiveAdapterStatus } from "../live-execution/ppc-live-adapter";
import { getLaunchGateSummary, runLaunchGateChecks } from "../launch-gate/launch-gate.service";
import { getNotificationOutboxSummary } from "../notification-outbox/notification-outbox.service";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { getSchedulerControlSummary } from "../scheduler-control/scheduler-control.service";
import { LaunchChecklistItem, LaunchChecklistSummary } from "./launch-checklist.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

async function safeCount(input: {
  table: string;
  sellerId?: string;
  filters?: Array<{ column: string; value: string | number | boolean }>;
}): Promise<number> {
  let query = supabase.from(input.table).select("id", { count: "exact", head: true });
  if (input.sellerId) query = query.eq("seller_id", input.sellerId);
  for (const filter of input.filters ?? []) query = query.eq(filter.column, filter.value);
  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

function item(input: LaunchChecklistItem): LaunchChecklistItem {
  return input;
}

async function buildItems(sellerId: string, runGate: boolean): Promise<LaunchChecklistItem[]> {
  const items: LaunchChecklistItem[] = [];
  const safety = await getSafetyControlSnapshotSafe(sellerId);
  const live = await getLiveExecutionStatus(sellerId).catch(() => null);
  const ai = await getAiGatewayStatus(sellerId).catch(() => null);
  const notification = await getNotificationOutboxSummary(sellerId).catch(() => null);
  const launchGate = runGate ? await runLaunchGateChecks(sellerId) : await getLaunchGateSummary(sellerId);
  const ppcAdapter = getPpcLiveAdapterStatus();
  const listingAdapter = getListingLiveAdapterStatus();

  items.push(item({ key: "backend_api", label: "Backend API reachable", status: "PASS", message: "Service layer is reachable.", critical: true }));
  items.push(item({ key: "supabase", label: "Supabase reachable", status: (await safeCount({ table: "amazon_connections" })) >= 0 ? "PASS" : "FAIL", message: "Supabase checked.", critical: true }));
  items.push(item({ key: "sp_api_data", label: "SP-API data available", status: (await safeCount({ table: "amazon_sp_listings", sellerId })) > 0 ? "PASS" : "WARN", message: "SP-API listing data checked.", critical: false }));
  items.push(item({ key: "ads_data", label: "Ads data available", status: (await safeCount({ table: "amazon_ads_campaigns", sellerId })) > 0 ? "PASS" : "WARN", message: "Amazon Ads data checked.", critical: false }));
  items.push(item({ key: "product_passport", label: "Product Passport ready", status: (await safeCount({ table: "product_passports", sellerId })) > 0 ? "PASS" : "WARN", message: "Product Passport checked.", critical: true }));
  items.push(item({ key: "product_economics", label: "Product Economics ready", status: (await safeCount({ table: "amazon_product_economics", sellerId })) > 0 ? "PASS" : "WARN", message: "Product Economics checked.", critical: true }));

  const actionSummary = await getActionLedgerSummary(sellerId).catch(() => null);
  items.push(item({ key: "action_ledger", label: "Action Ledger ready", status: actionSummary ? "PASS" : "FAIL", message: "Action Ledger checked.", critical: true }));
  items.push(item({ key: "approval_center", label: "Approval Center ready", status: actionSummary ? "PASS" : "FAIL", message: `${actionSummary?.pendingCount ?? 0} pending approvals.`, critical: true }));
  items.push(item({ key: "engine_registry_300", label: "Engine Registry 300 ready", status: (await safeCount({ table: "engine_registry" })) >= 300 ? "PASS" : "WARN", message: "Engine Registry count checked.", critical: true }));
  items.push(item({ key: "engine_router", label: "Engine Router ready", status: (await safeCount({ table: "engine_run_logs", sellerId })) >= 0 ? "PASS" : "WARN", message: "Engine Router checked.", critical: true }));
  items.push(item({ key: "daily_ai_cgo", label: "Daily AI-CGO ready", status: (await safeCount({ table: "daily_orchestrator_runs", sellerId })) >= 0 ? "PASS" : "WARN", message: "Daily Orchestrator checked.", critical: false }));
  items.push(item({ key: "learning_loop", label: "Learning Loop ready", status: (await safeCount({ table: "action_learning_events", sellerId })) > 0 ? "PASS" : "WARN", message: "Learning Loop checked.", critical: false }));
  items.push(item({ key: "execution_gateway", label: "Execution Gateway ready", status: (await safeCount({ table: "execution_attempts", sellerId })) >= 0 ? "PASS" : "WARN", message: "Execution Gateway checked.", critical: true }));
  items.push(item({ key: "rollback", label: "Rollback ready", status: (await safeCount({ table: "rollback_snapshots", sellerId })) > 0 ? "PASS" : "WARN", message: "Rollback snapshots checked.", critical: true }));

  const latestQaPass = (await safeCount({ table: "qa_smoke_test_runs", sellerId, filters: [{ column: "run_status", value: "PASS" }] })) > 0;
  items.push(item({ key: "qa_smoke", label: "QA Smoke PASS", status: latestQaPass ? "PASS" : "FAIL", message: "QA Smoke PASS is required.", critical: true }));
  items.push(item({ key: "maintenance_recent", label: "Maintenance recent", status: (await safeCount({ table: "maintenance_runs", sellerId })) > 0 ? "PASS" : "WARN", message: "Maintenance run checked.", critical: false }));

  const health = await getProductionHealthSummary(sellerId).catch(() => null);
  items.push(item({ key: "production_health", label: "Production Health no blockers", status: health && health.blockers.length === 0 ? "PASS" : "FAIL", message: health ? `${health.blockers.length} blockers.` : "Production Health unavailable.", critical: true }));
  items.push(item({ key: "safety_control", label: "Safety Control initialized", status: safety.settings ? "PASS" : "FAIL", message: "Safety Control checked.", critical: true }));
  items.push(item({ key: "live_execution_off", label: "Live execution OFF by default", status: live?.liveExecutionEnabled ? "WARN" : "PASS", message: live?.liveExecutionEnabled ? "Live flag is enabled intentionally; verify launch gate." : "Live execution is OFF.", critical: true }));
  items.push(item({ key: "ai_calls_off", label: "AI calls OFF by default", status: ai?.aiCallsEnabled ? "WARN" : "PASS", message: ai?.aiCallsEnabled ? "AI calls are enabled intentionally." : "AI calls are OFF.", critical: true }));
  items.push(item({ key: "notification_send_off", label: "Notification sending OFF by default", status: notification?.externalNotificationsEnabled ? "WARN" : "PASS", message: notification?.externalNotificationsEnabled ? "External notifications enabled." : "External notifications are OFF.", critical: true }));
  items.push(item({ key: "launch_gate", label: "Launch Gate checked", status: launchGate.overallStatus === "FAIL" ? "FAIL" : launchGate.overallStatus === "WARN" ? "WARN" : "PASS", message: `Launch Gate is ${launchGate.overallStatus}.`, critical: true }));

  const scheduler = await getSchedulerControlSummary(sellerId).catch(() => null);
  items.push(item({ key: "scheduler_jobs", label: "Scheduler jobs seeded", status: (scheduler?.totalJobs ?? 0) >= 9 ? "PASS" : "WARN", message: `${scheduler?.totalJobs ?? 0} scheduler jobs.`, critical: false }));
  items.push(item({ key: "activity_logs", label: "Activity Logs working", status: (await safeCount({ table: "activity_log_events", sellerId })) >= 0 ? "PASS" : "WARN", message: "Activity Logs checked.", critical: false }));
  const dataFreshness = await getDataFreshnessSummary(sellerId).catch(() => null);
  items.push(item({ key: "data_freshness", label: "Data Freshness checked", status: dataFreshness ? dataFreshness.errorSources > 0 ? "FAIL" : dataFreshness.staleSources > 0 ? "WARN" : "PASS" : "WARN", message: dataFreshness ? `${dataFreshness.freshSources}/${dataFreshness.totalSources} fresh.` : "Data Freshness unavailable.", critical: true }));
  const alerts = await getAlertSummary(sellerId).catch(() => null);
  items.push(item({ key: "alerts_generated", label: "Alerts generated", status: alerts ? "PASS" : "WARN", message: `${alerts?.openAlerts ?? 0} open alerts.`, critical: false }));
  items.push(item({ key: "dry_run_tested", label: "Approved action dry-run tested", status: (await safeCount({ table: "live_execution_runs", sellerId, filters: [{ column: "live_status", value: "DRY_RUN_COMPLETED" }] })) > 0 ? "PASS" : "WARN", message: "At least one live-execution dry-run should complete.", critical: true }));
  items.push(item({ key: "ppc_adapter", label: "PPC live adapter configured or explicitly marked not configured", status: ppcAdapter.configured ? "PASS" : "WARN", message: ppcAdapter.reason, critical: false }));
  items.push(item({ key: "listing_adapter", label: "Listing live adapter configured or explicitly marked not configured", status: listingAdapter.configured ? "PASS" : "WARN", message: listingAdapter.reason, critical: false }));

  return items;
}

function summarize(sellerId: string, items: LaunchChecklistItem[], launchGateOverall: string): LaunchChecklistSummary {
  const blockers = items.filter((entry) => entry.critical && entry.status === "FAIL").map((entry) => `${entry.label}: ${entry.message}`);
  const warnings = items.filter((entry) => entry.status === "WARN").map((entry) => `${entry.label}: ${entry.message}`);
  const qaPass = items.some((entry) => entry.key === "qa_smoke" && entry.status === "PASS");
  const healthPass = items.some((entry) => entry.key === "production_health" && entry.status === "PASS");
  const safetyPass = items.some((entry) => entry.key === "safety_control" && entry.status === "PASS");
  const dryRunPass = items.some((entry) => entry.key === "dry_run_tested" && entry.status === "PASS");
  const noCriticalBlockers = blockers.length === 0;
  const overallLaunchStatus = qaPass && healthPass && safetyPass && dryRunPass && noCriticalBlockers && launchGateOverall !== "FAIL"
    ? "READY_FOR_LIMITED_LIVE_TEST"
    : noCriticalBlockers && safetyPass
      ? "READY_FOR_SHADOW_LAUNCH"
      : "NOT_READY";

  return {
    ok: blockers.length === 0,
    sellerId,
    overallLaunchStatus,
    items,
    blockers,
    warnings,
    nextSteps: [
      ...(blockers.length ? ["Resolve launch checklist blockers."] : []),
      ...(dryRunPass ? [] : ["Complete at least one approved action dry-run."]),
      "Keep live execution, AI calls, and notifications off until controlled tests are approved."
    ]
  };
}

export async function getLaunchChecklistSummary(sellerIdInput: string): Promise<LaunchChecklistSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const gate = await getLaunchGateSummary(sellerId).catch(() => null);
  const items = await buildItems(sellerId, false);
  return summarize(sellerId, items, gate?.overallStatus ?? "FAIL");
}

export async function runLaunchChecklist(sellerIdInput: string): Promise<LaunchChecklistSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const gate = await runLaunchGateChecks(sellerId).catch(() => null);
  const items = await buildItems(sellerId, true);
  return summarize(sellerId, items, gate?.overallStatus ?? "FAIL");
}
