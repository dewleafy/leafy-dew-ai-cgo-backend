import { supabase } from "../../db/supabase";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { getWorkflowEvents } from "../action-ledger/action-workflow.service";
import { getCriticalDataSourceSet, getDataFreshnessSummary } from "../data-freshness/data-freshness.service";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { SafetyControlSettingsRow } from "../safety-control/safety-control.types";
import { getListingLiveAdapterStatus } from "./listing-live-adapter";
import {
  LiveExecutionDomain,
  LiveExecutionRunRow,
  PreflightCheck,
  PreflightResult,
  REQUIRED_LIVE_CONFIRM_TEXT,
  SafeLiveExecutionRun,
  SUPPORTED_LISTING_LIVE_ACTION_TYPES,
  SUPPORTED_PPC_LIVE_ACTION_TYPES
} from "./live-execution.types";
import { getPpcLiveAdapterStatus } from "./ppc-live-adapter";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNullableJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function check(input: Omit<PreflightCheck, "severity"> & { severity?: PreflightCheck["severity"] }): PreflightCheck {
  return {
    severity: input.severity ?? (input.status === "BLOCKED" ? "HIGH" : "LOW"),
    ...input
  };
}

function domainForAction(actionType: string | null): LiveExecutionDomain | null {
  if (!actionType) return null;
  if (SUPPORTED_PPC_LIVE_ACTION_TYPES.has(actionType)) return "PPC";
  if (SUPPORTED_LISTING_LIVE_ACTION_TYPES.has(actionType)) return "LISTING";
  return null;
}

async function getRawSafetySettings(sellerId: string): Promise<SafetyControlSettingsRow | null> {
  const { data, error } = await supabase
    .from("safety_control_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<SafetyControlSettingsRow>();

  if (error) throw new Error(error.message);
  return data ?? null;
}

async function latestPassQaWithin24h(sellerId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("qa_smoke_test_runs")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .eq("run_status", "PASS")
    .gte("started_at", since);
  if (error) return false;
  return (count ?? 0) > 0;
}

async function countToday(input: {
  table: string;
  sellerId: string;
  timestampColumn: string;
  filters?: Array<{ column: string; value: string | number | boolean }>;
}): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let query = supabase
    .from(input.table)
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId)
    .gte(input.timestampColumn, today.toISOString());
  for (const filter of input.filters ?? []) query = query.eq(filter.column, filter.value);
  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

async function countLiveExecutedForAction(sellerId: string, actionId: string): Promise<number> {
  const { count, error } = await supabase
    .from("live_execution_runs")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .eq("action_id", actionId)
    .eq("live_status", "LIVE_EXECUTED");
  if (error) return 0;
  return count ?? 0;
}

async function latestRollbackSnapshotId(sellerId: string, actionId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("rollback_snapshots")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("action_id", actionId)
    .eq("snapshot_status", "CAPTURED")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Array<{ id: string }>)[0];
  return row?.id ?? null;
}

function toSafeLiveRun(row: LiveExecutionRunRow): SafeLiveExecutionRun {
  return {
    id: row.id,
    sellerId: row.seller_id,
    actionId: row.action_id,
    executionAttemptId: row.execution_attempt_id,
    rollbackSnapshotId: row.rollback_snapshot_id,
    executionDomain: row.execution_domain,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    liveStatus: row.live_status,
    dryRunStatus: row.dry_run_status,
    actor: row.actor,
    confirmText: row.confirm_text,
    requestPayload: toJsonObject(row.request_payload),
    executionPlan: toJsonObject(row.execution_plan),
    preflightResult: toJsonObject(row.preflight_result),
    externalResponse: toNullableJsonObject(row.external_response),
    blockedReason: row.blocked_reason,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at
  };
}

async function latestCompletedDryRun(sellerId: string, actionId: string): Promise<SafeLiveExecutionRun | null> {
  const { data, error } = await supabase
    .from("live_execution_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("action_id", actionId)
    .eq("live_status", "DRY_RUN_COMPLETED")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as LiveExecutionRunRow[])[0];
  return row ? toSafeLiveRun(row) : null;
}

async function hasApprovalWorkflowEvidence(sellerId: string, actionId: string, approvedAt: string | null): Promise<boolean> {
  if (approvedAt) return true;
  try {
    const events = await getWorkflowEvents(actionId, sellerId);
    return events.some((event) => event.toState === "APPROVED" || event.eventType.toUpperCase().includes("APPROV"));
  } catch {
    return false;
  }
}

async function accountMetadataExists(action: { actionType: string; payload: Record<string, unknown> }, domain: LiveExecutionDomain | null): Promise<boolean> {
  if (!domain) return false;
  const payload = toJsonObject(action.payload);
  if (domain === "PPC") {
    return Boolean(cleanText(payload.profileId) ?? cleanText(payload.profile_id) ?? cleanText(payload.marketplaceId) ?? cleanText(payload.marketplace_id));
  }
  return Boolean(cleanText(payload.marketplaceId) ?? cleanText(payload.marketplace_id) ?? cleanText(payload.marketplace));
}

function dailyDomainLimit(settings: SafetyControlSettingsRow | null, domain: LiveExecutionDomain): number {
  const rules = toJsonObject(settings?.approval_tier_rules);
  if (domain === "PPC") return Math.max(Math.floor(toNumber(rules.maxDailyPpcLiveExecutions, 3)), 0);
  return Math.max(Math.floor(toNumber(rules.maxDailyListingLiveExecutions, 3)), 0);
}

export async function runLiveExecutionPreflight(input: {
  actionId: string;
  sellerId?: string | null;
  mode: "DRY_RUN" | "LIVE";
  confirmText?: string | null;
}): Promise<PreflightResult> {
  const action = await getActionLedgerById(input.actionId);
  const sellerId = cleanText(input.sellerId) ?? action?.sellerId ?? "default";
  const checks: PreflightCheck[] = [];

  if (!action) {
    checks.push(check({ key: "action_exists", status: "BLOCKED", message: "Action does not exist.", severity: "CRITICAL" }));
    return {
      ok: false,
      sellerId,
      actionId: cleanText(input.actionId) ?? "",
      mode: input.mode,
      executionDomain: null,
      actionType: null,
      checks,
      blockers: ["ACTION_NOT_FOUND"],
      warnings: [],
      blockedReason: "ACTION_NOT_FOUND",
      safetyChecks: {}
    };
  }

  const domain = domainForAction(action.actionType);
  const settings = await getRawSafetySettings(sellerId).catch(() => null);
  const latestDryRun = input.mode === "LIVE"
    ? await latestCompletedDryRun(sellerId, action.id)
    : null;
  const rollbackSnapshotId = await latestRollbackSnapshotId(sellerId, action.id);

  checks.push(check({
    key: "seller_match",
    status: action.sellerId === sellerId ? "PASS" : "BLOCKED",
    message: action.sellerId === sellerId ? "Seller matches action." : "Action seller does not match request seller.",
    severity: "CRITICAL"
  }));
  checks.push(check({
    key: "approved_action",
    status: action.approvalStatus === "APPROVED" || action.state === "APPROVED" || action.state === "MONITORING" ? "PASS" : "BLOCKED",
    message: "Action must be approved before execution.",
    severity: "CRITICAL"
  }));
  checks.push(check({
    key: "supported_action_type",
    status: domain ? "PASS" : "BLOCKED",
    message: domain ? `${action.actionType} is supported for ${domain}.` : `${action.actionType} is not supported for live execution.`,
    severity: "CRITICAL"
  }));
  checks.push(check({
    key: "critical_risk_tier",
    status: action.riskLevel === "CRITICAL" && action.approvalTier !== "FOUNDER_OVERRIDE" ? "BLOCKED" : "PASS",
    message: "Critical risk actions require founder override tier.",
    severity: "CRITICAL"
  }));
  checks.push(check({
    key: "safety_control_initialized",
    status: settings ? "PASS" : "BLOCKED",
    message: settings ? "Safety Control settings exist." : "Safety Control settings are missing.",
    severity: "CRITICAL"
  }));
  checks.push(check({
    key: "global_mode_safe",
    status: settings && settings.global_mode !== "UNSAFE" ? "PASS" : "BLOCKED",
    message: "Safety Control global mode must not be UNSAFE.",
    severity: "CRITICAL"
  }));

  if (input.mode === "LIVE") {
    checks.push(check({
      key: "live_execution_enabled",
      status: settings?.live_execution_enabled ? "PASS" : "BLOCKED",
      message: "Global live execution flag must be explicitly enabled.",
      severity: "CRITICAL"
    }));
    checks.push(check({
      key: "domain_live_enabled",
      status: domain === "PPC"
        ? settings?.ppc_live_execution_enabled ? "PASS" : "BLOCKED"
        : domain === "LISTING"
          ? settings?.listing_live_execution_enabled ? "PASS" : "BLOCKED"
          : "BLOCKED",
      message: `${domain ?? "Domain"} live execution flag must be explicitly enabled.`,
      severity: "CRITICAL"
    }));
    checks.push(check({
      key: "confirm_text",
      status: cleanText(input.confirmText) === REQUIRED_LIVE_CONFIRM_TEXT ? "PASS" : "BLOCKED",
      message: `Confirm text must equal ${REQUIRED_LIVE_CONFIRM_TEXT}.`,
      severity: "CRITICAL"
    }));
    checks.push(check({
      key: "dry_run_exists",
      status: latestDryRun ? "PASS" : "BLOCKED",
      message: "A completed dry-run is required before live execution.",
      severity: "CRITICAL"
    }));
  }

  const qaPass = await latestPassQaWithin24h(sellerId);
  checks.push(check({
    key: "qa_smoke_recent_pass",
    status: qaPass ? "PASS" : "BLOCKED",
    message: "Latest QA smoke must be PASS within 24 hours.",
    severity: "CRITICAL"
  }));

  await getProductionHealthSummary(sellerId)
    .then((summary) => checks.push(check({
      key: "production_health_no_blockers",
      status: summary.blockers.length === 0 ? "PASS" : "BLOCKED",
      message: summary.blockers.length === 0 ? "Production Health has no blockers." : "Production Health has blockers.",
      severity: "CRITICAL",
      metadata: { blockers: summary.blockers }
    })))
    .catch(() => checks.push(check({ key: "production_health_no_blockers", status: "BLOCKED", message: "Production Health is unavailable.", severity: "CRITICAL" })));

  await getDataFreshnessSummary(sellerId)
    .then((summary) => {
      const critical = getCriticalDataSourceSet();
      const staleCritical = summary.rows.filter((row) => critical.has(row.dataSource) && (row.status === "STALE" || row.status === "ERROR"));
      checks.push(check({
        key: "critical_data_freshness",
        status: staleCritical.length ? "BLOCKED" : "PASS",
        message: staleCritical.length ? "Critical data freshness has stale/error sources." : "Critical data freshness is acceptable.",
        severity: "HIGH",
        metadata: { staleCritical: staleCritical.map((row) => row.dataSource) }
      }));
    })
    .catch(() => checks.push(check({ key: "critical_data_freshness", status: "BLOCKED", message: "Data Freshness is unavailable.", severity: "HIGH" })));

  checks.push(check({
    key: "rollback_snapshot",
    status: rollbackSnapshotId || input.mode === "DRY_RUN" ? "PASS" : "BLOCKED",
    message: rollbackSnapshotId ? "Rollback snapshot exists." : "Rollback snapshot is required before live execution.",
    severity: "CRITICAL",
    metadata: { rollbackSnapshotId }
  }));
  checks.push(check({
    key: "not_already_live_executed",
    status: (await countLiveExecutedForAction(sellerId, action.id)) === 0 ? "PASS" : "BLOCKED",
    message: "Action must not already be live executed.",
    severity: "CRITICAL"
  }));

  const maxAttempts = Math.max(Math.floor(toNumber(settings?.max_daily_execution_attempts, 25)), 0);
  const attemptsToday = await countToday({ table: "execution_attempts", sellerId, timestampColumn: "created_at" });
  checks.push(check({
    key: "daily_execution_attempt_limit",
    status: attemptsToday < maxAttempts ? "PASS" : "BLOCKED",
    message: `Daily execution attempts ${attemptsToday}/${maxAttempts}.`,
    severity: "HIGH"
  }));

  if (domain) {
    const liveToday = await countToday({
      table: "live_execution_runs",
      sellerId,
      timestampColumn: "created_at",
      filters: [{ column: "execution_domain", value: domain }, { column: "live_status", value: "LIVE_EXECUTED" }]
    });
    const limit = dailyDomainLimit(settings, domain);
    checks.push(check({
      key: "daily_domain_live_limit",
      status: liveToday < limit ? "PASS" : "BLOCKED",
      message: `${domain} live executions today ${liveToday}/${limit}.`,
      severity: "HIGH"
    }));
  }

  checks.push(check({
    key: "workflow_approval_event",
    status: await hasApprovalWorkflowEvidence(sellerId, action.id, action.approvedAt) ? "PASS" : "BLOCKED",
    message: "Action workflow must include approval evidence.",
    severity: "HIGH"
  }));

  if (input.mode === "LIVE" && domain) {
    const adapterStatus = domain === "PPC" ? getPpcLiveAdapterStatus() : getListingLiveAdapterStatus();
    checks.push(check({
      key: "mutation_client_configured",
      status: adapterStatus.configured ? "PASS" : "BLOCKED",
      message: adapterStatus.reason,
      severity: "CRITICAL"
    }));
    checks.push(check({
      key: "marketplace_account_metadata",
      status: await accountMetadataExists(action, domain) ? "PASS" : "BLOCKED",
      message: "Marketplace/account safety metadata is required for live execution.",
      severity: "HIGH"
    }));
  }

  const blockers = checks.filter((item) => item.status === "BLOCKED").map((item) => item.key);
  const warnings = checks.filter((item) => item.status === "WARN").map((item) => item.message);

  return {
    ok: blockers.length === 0,
    sellerId,
    actionId: action.id,
    mode: input.mode,
    executionDomain: domain,
    actionType: action.actionType,
    checks,
    blockers,
    warnings,
    blockedReason: blockers[0] ?? null,
    safetyChecks: {
      liveExecutionEnabled: Boolean(settings?.live_execution_enabled),
      ppcLiveExecutionEnabled: Boolean(settings?.ppc_live_execution_enabled),
      listingLiveExecutionEnabled: Boolean(settings?.listing_live_execution_enabled),
      aiCallsEnabled: Boolean(settings?.ai_calls_enabled),
      globalMode: settings?.global_mode ?? null
    },
    action,
    latestDryRun,
    rollbackSnapshotId
  };
}
