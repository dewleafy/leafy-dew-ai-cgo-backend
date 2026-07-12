import { supabase } from "../../db/supabase";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { recordWorkflowEvent, transitionActionState } from "../action-ledger/action-workflow.service";
import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { captureRollbackSnapshotSafe } from "../rollback/rollback.service";
import { SafetyControlSettingsRow } from "../safety-control/safety-control.types";
import { checkSecurityGuardrail } from "../security-guardrails/security-guardrails.service";
import { buildListingPlan, dryRunListingPlan, executeListingPlan } from "./listing-live-adapter";
import {
  LiveExecutionPlan,
  LiveExecutionRequest,
  LiveExecutionRunRow,
  PreflightResult,
  SafeLiveExecutionRun
} from "./live-execution.types";
import { buildPpcPlan, dryRunPpcPlan, executePpcPlan, getPpcLiveAdapterStatus } from "./ppc-live-adapter";
import { getListingLiveAdapterStatus } from "./listing-live-adapter";
import { runLiveExecutionPreflight } from "./preflight.service";

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

export function toSafeLiveExecutionRun(row: LiveExecutionRunRow): SafeLiveExecutionRun {
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

async function getRawSafetySettings(sellerId: string): Promise<SafetyControlSettingsRow | null> {
  const { data, error } = await supabase
    .from("safety_control_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<SafetyControlSettingsRow>();
  if (error) return null;
  return data ?? null;
}

function buildPlan(action: SafeActionLedgerRow): LiveExecutionPlan {
  if (
    action.actionType === "LISTING_TITLE_DRAFT_REVIEW" ||
    action.actionType === "LISTING_BULLETS_DRAFT_REVIEW" ||
    action.actionType === "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW" ||
    action.actionType === "LISTING_DESCRIPTION_DRAFT_REVIEW"
  ) {
    return buildListingPlan(action);
  }

  return buildPpcPlan(action);
}

async function createExecutionAttempt(input: {
  action: SafeActionLedgerRow;
  mode: "DRY_RUN" | "LIVE";
  status: string;
  actor: string;
  requestPayload: Record<string, unknown>;
  plan: Record<string, unknown>;
  preflight: Record<string, unknown>;
  rollbackSnapshotId?: string | null;
  blockedReason?: string | null;
  resultMessage?: string | null;
  errorMessage?: string | null;
}): Promise<string | null> {
  const { data, error } = await supabase
    .from("execution_attempts")
    .insert({
      seller_id: input.action.sellerId,
      action_id: input.action.id,
      source: input.action.source,
      source_id: input.action.sourceId,
      action_type: input.action.actionType,
      entity_type: input.action.entityType,
      entity_id: input.action.entityId,
      sku: input.action.sku,
      asin: input.action.asin,
      execution_mode: input.mode === "LIVE" ? "LIVE" : "SHADOW",
      execution_status: input.status,
      actor: input.actor,
      request_payload: input.requestPayload,
      planned_change: input.plan,
      snapshot_before: input.action,
      rollback_snapshot: input.rollbackSnapshotId ? { snapshotId: input.rollbackSnapshotId } : input.action.rollbackSnapshot,
      safety_checks: input.preflight,
      blocked_reason: cleanText(input.blockedReason),
      result_message: cleanText(input.resultMessage),
      error_message: cleanText(input.errorMessage),
      finished_at: new Date().toISOString()
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) return null;
  return data.id;
}

async function createLiveRun(input: {
  action: SafeActionLedgerRow;
  plan: LiveExecutionPlan | Record<string, unknown>;
  preflight: PreflightResult | Record<string, unknown>;
  liveStatus: string;
  dryRunStatus?: string | null;
  actor: string;
  confirmText?: string | null;
  requestPayload?: Record<string, unknown>;
  executionAttemptId?: string | null;
  rollbackSnapshotId?: string | null;
  externalResponse?: Record<string, unknown> | null;
  blockedReason?: string | null;
  errorMessage?: string | null;
}): Promise<SafeLiveExecutionRun> {
  const { data, error } = await supabase
    .from("live_execution_runs")
    .insert({
      seller_id: input.action.sellerId,
      action_id: input.action.id,
      execution_attempt_id: cleanText(input.executionAttemptId),
      rollback_snapshot_id: cleanText(input.rollbackSnapshotId),
      execution_domain: "domain" in input.plan ? input.plan.domain : "UNKNOWN",
      action_type: input.action.actionType,
      entity_type: input.action.entityType,
      entity_id: input.action.entityId,
      sku: input.action.sku,
      asin: input.action.asin,
      live_status: input.liveStatus,
      dry_run_status: cleanText(input.dryRunStatus),
      actor: input.actor,
      confirm_text: cleanText(input.confirmText),
      request_payload: input.requestPayload ?? {},
      execution_plan: input.plan,
      preflight_result: input.preflight,
      external_response: input.externalResponse ?? null,
      blocked_reason: cleanText(input.blockedReason),
      error_message: cleanText(input.errorMessage),
      finished_at: new Date().toISOString()
    })
    .select("*")
    .single<LiveExecutionRunRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not create live execution run.");
  return toSafeLiveExecutionRun(data);
}

export async function getLiveExecutionStatus(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  liveExecutionEnabled: boolean;
  ppcLiveExecutionEnabled: boolean;
  listingLiveExecutionEnabled: boolean;
  imageLiveExecutionEnabled: boolean;
  aPlusLiveExecutionEnabled: boolean;
  aiCallsEnabled: boolean;
  mode: string;
  message: string;
  adapters: Record<string, unknown>;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const settings = await getRawSafetySettings(sellerId);
  return {
    ok: true,
    sellerId,
    liveExecutionEnabled: Boolean(settings?.live_execution_enabled),
    ppcLiveExecutionEnabled: Boolean(settings?.ppc_live_execution_enabled),
    listingLiveExecutionEnabled: Boolean(settings?.listing_live_execution_enabled),
    imageLiveExecutionEnabled: Boolean(settings?.image_live_execution_enabled),
    aPlusLiveExecutionEnabled: Boolean(settings?.a_plus_live_execution_enabled),
    aiCallsEnabled: Boolean(settings?.ai_calls_enabled),
    mode: settings?.global_mode ?? "SHADOW",
    message: settings?.live_execution_enabled
      ? "Live execution is gated by approval, QA, health, rollback, dry-run, confirm text, and adapter configuration."
      : "Live execution is OFF by default.",
    adapters: {
      ppc: getPpcLiveAdapterStatus(),
      listing: getListingLiveAdapterStatus(),
      image: { configured: false, reason: "IMAGE_LIVE_EXECUTION_NOT_SUPPORTED_IN_THIS_BATCH" },
      aPlus: { configured: false, reason: "A_PLUS_LIVE_EXECUTION_NOT_SUPPORTED_IN_THIS_BATCH" }
    }
  };
}

export async function preflightLiveExecution(actionId: string, input: LiveExecutionRequest = {}): Promise<PreflightResult> {
  return runLiveExecutionPreflight({
    actionId,
    sellerId: input.sellerId,
    mode: "LIVE",
    confirmText: input.confirmText
  });
}

export async function dryRunLiveExecution(actionId: string, input: LiveExecutionRequest = {}): Promise<{
  ok: boolean;
  action: SafeActionLedgerRow;
  run: SafeLiveExecutionRun;
  executionPlan: LiveExecutionPlan;
  preflightResult: PreflightResult;
  safetyChecks: Record<string, unknown>;
}> {
  const preflight = await runLiveExecutionPreflight({ actionId, sellerId: input.sellerId, mode: "DRY_RUN" });
  if (!preflight.action) throw new Error("ACTION_NOT_FOUND");
  const action = preflight.action;
  const actor = cleanText(input.actor) ?? "founder";
  const requestPayload = input.requestPayload ?? {};
  const plan = buildPlan(action);
  const dryRunResult = plan.domain === "PPC" ? dryRunPpcPlan(plan) : dryRunListingPlan(plan);
  const rollbackSnapshot = await captureRollbackSnapshotSafe({
    actionId: action.id,
    sellerId: action.sellerId,
    sourceModule: "live-execution",
    capturedBy: actor,
    plannedChange: plan as unknown as Record<string, unknown>,
    notes: "Captured before live-execution dry-run."
  });
  const blockedReason = preflight.ok && dryRunResult.ok ? null : preflight.blockedReason ?? dryRunResult.blockedReason ?? "DRY_RUN_BLOCKED";
  const attemptId = await createExecutionAttempt({
    action,
    mode: "DRY_RUN",
    status: blockedReason ? "DRY_RUN_BLOCKED" : "DRY_RUN_COMPLETED",
    actor,
    requestPayload,
    plan: plan as unknown as Record<string, unknown>,
    preflight: preflight as unknown as Record<string, unknown>,
    rollbackSnapshotId: rollbackSnapshot?.id ?? null,
    blockedReason,
    resultMessage: blockedReason ? "Dry-run blocked. No external action executed." : "Dry-run completed. No external action executed."
  });
  const run = await createLiveRun({
    action,
    plan,
    preflight,
    liveStatus: blockedReason ? "BLOCKED" : "DRY_RUN_COMPLETED",
    dryRunStatus: blockedReason ? "BLOCKED" : "PASS",
    actor,
    requestPayload,
    executionAttemptId: attemptId,
    rollbackSnapshotId: rollbackSnapshot?.id ?? null,
    externalResponse: dryRunResult.externalResponse,
    blockedReason
  });

  await safeRecordActivityLog({
    sellerId: action.sellerId,
    eventType: blockedReason ? "LIVE_EXECUTION_DRY_RUN_BLOCKED" : "LIVE_EXECUTION_DRY_RUN_COMPLETED",
    eventCategory: "EXECUTION",
    severity: blockedReason ? "WARNING" : "SUCCESS",
    actor,
    title: blockedReason ? "Live execution dry-run blocked" : "Live execution dry-run completed",
    message: blockedReason ? "Live execution dry-run was blocked. No external action executed." : "Live execution dry-run completed. No external action executed.",
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    actionId: action.id,
    sourceModule: "live-execution",
    metadata: { runId: run.id, attemptId, rollbackSnapshotId: rollbackSnapshot?.id ?? null, blockedReason }
  });

  await recordLearningEventSafe({
    sellerId: action.sellerId,
    actionId: action.id,
    source: action.source,
    sourceId: action.sourceId,
    actionType: action.actionType,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    eventType: blockedReason ? "SHADOW_EXECUTION_FAILED" : "SHADOW_EXECUTION_COMPLETED",
    actor,
    note: blockedReason ?? "Live execution dry-run completed.",
    evidence: { runId: run.id, attemptId },
    metadata: { liveExecutionDryRun: true, externalExecution: false }
  });

  return {
    ok: !blockedReason,
    action,
    run,
    executionPlan: plan,
    preflightResult: preflight,
    safetyChecks: preflight.safetyChecks
  };
}

export async function executeLiveExecution(actionId: string, input: LiveExecutionRequest = {}): Promise<{
  ok: boolean;
  action: SafeActionLedgerRow;
  run: SafeLiveExecutionRun;
  blockedReason: string | null;
  message: string;
}> {
  const preflight = await runLiveExecutionPreflight({
    actionId,
    sellerId: input.sellerId,
    mode: "LIVE",
    confirmText: input.confirmText
  });
  if (!preflight.action) throw new Error("ACTION_NOT_FOUND");

  const action = preflight.action;
  const actor = cleanText(input.actor) ?? "founder";
  const requestPayload = input.requestPayload ?? {};
  const plan = buildPlan(action);
  const security = await checkSecurityGuardrail({
    sellerId: action.sellerId,
    actor,
    action: plan.domain === "PPC" ? "LIVE_PPC_EXECUTION" : "LIVE_LISTING_EXECUTION",
    route: "/api/live-execution/execute-live/:actionId",
    confirmText: input.confirmText,
    metadata: { actionId: action.id, actionType: action.actionType, domain: plan.domain }
  }).catch(() => null);
  const securityBlockedReason = security && !security.allowed ? security.reason ?? "SECURITY_GUARDRAIL_BLOCKED" : null;

  if (!preflight.ok || securityBlockedReason) {
    const blockedReason = preflight.blockedReason ?? securityBlockedReason;
    const attemptId = await createExecutionAttempt({
      action,
      mode: "LIVE",
      status: "LIVE_BLOCKED",
      actor,
      requestPayload,
      plan: plan as unknown as Record<string, unknown>,
      preflight: preflight as unknown as Record<string, unknown>,
      rollbackSnapshotId: preflight.rollbackSnapshotId ?? null,
      blockedReason,
      resultMessage: "Live execution blocked by preflight."
    });
    const run = await createLiveRun({
      action,
      plan,
      preflight,
      liveStatus: "BLOCKED",
      actor,
      confirmText: input.confirmText,
      requestPayload,
      executionAttemptId: attemptId,
      rollbackSnapshotId: preflight.rollbackSnapshotId ?? null,
      blockedReason
    });

    await safeRecordActivityLog({
      sellerId: action.sellerId,
      eventType: "LIVE_EXECUTION_BLOCKED",
      eventCategory: "EXECUTION",
      severity: "WARNING",
      actor,
      title: "Live execution blocked",
      message: `Live execution blocked: ${blockedReason ?? "preflight failed"}.`,
      entityType: action.entityType,
      entityId: action.entityId,
      sku: action.sku,
      asin: action.asin,
      actionId: action.id,
      sourceModule: "live-execution",
      metadata: { runId: run.id, attemptId, blockers: preflight.blockers }
    });

    await recordLearningEventSafe({
      sellerId: action.sellerId,
      actionId: action.id,
      source: action.source,
      sourceId: action.sourceId,
      actionType: action.actionType,
      entityType: action.entityType,
      entityId: action.entityId,
      sku: action.sku,
      asin: action.asin,
      eventType: "LIVE_EXECUTION_BLOCKED",
      actor,
      note: blockedReason,
      evidence: { runId: run.id, attemptId },
      metadata: { liveExecution: true, blockers: preflight.blockers }
    });

    return {
      ok: false,
      action,
      run,
      blockedReason,
      message: "Live execution blocked. No external action executed."
    };
  }

  const result = plan.domain === "PPC" ? await executePpcPlan(plan) : await executeListingPlan(plan);
  const blockedReason = result.ok ? null : result.blockedReason ?? "LIVE_EXECUTION_FAILED";
  const attemptId = await createExecutionAttempt({
    action,
    mode: "LIVE",
    status: result.ok ? "LIVE_EXECUTED" : "LIVE_BLOCKED",
    actor,
    requestPayload,
    plan: plan as unknown as Record<string, unknown>,
    preflight: preflight as unknown as Record<string, unknown>,
    rollbackSnapshotId: preflight.rollbackSnapshotId ?? null,
    blockedReason,
    resultMessage: result.ok ? "Live execution completed." : "Live execution blocked by adapter."
  });
  const run = await createLiveRun({
    action,
    plan,
    preflight,
    liveStatus: result.ok ? "LIVE_EXECUTED" : "BLOCKED",
    actor,
    confirmText: input.confirmText,
    requestPayload,
    executionAttemptId: attemptId,
    rollbackSnapshotId: preflight.rollbackSnapshotId ?? null,
    externalResponse: result.externalResponse,
    blockedReason
  });

  if (result.ok) {
    await transitionActionState({
      actionId: action.id,
      sellerId: action.sellerId,
      toState: "MONITORING",
      approvalStatus: "MONITOR",
      eventType: "LIVE_EXECUTED",
      actor,
      note: "Live execution completed and moved to monitoring.",
      metadata: { runId: run.id, attemptId, rollbackSnapshotId: preflight.rollbackSnapshotId ?? null }
    }).catch(async () => {
      await recordWorkflowEvent({
        actionId: action.id,
        sellerId: action.sellerId,
        fromState: action.state,
        toState: "MONITORING",
        eventType: "LIVE_EXECUTED",
        actor,
        note: "Live execution completed; workflow transition fallback event recorded.",
        snapshotBefore: action,
        snapshotAfter: { run, externalResponse: result.externalResponse },
        rollbackSnapshot: { snapshotId: preflight.rollbackSnapshotId ?? null },
        metadata: { runId: run.id, attemptId }
      });
    });
  }

  await safeRecordActivityLog({
    sellerId: action.sellerId,
    eventType: result.ok ? "LIVE_EXECUTION_COMPLETED" : "LIVE_EXECUTION_BLOCKED",
    eventCategory: "EXECUTION",
    severity: result.ok ? "SUCCESS" : "WARNING",
    actor,
    title: result.ok ? "Live execution completed" : "Live execution blocked",
    message: result.ok ? "Live execution completed through configured adapter." : `Live execution blocked: ${blockedReason}.`,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    actionId: action.id,
    sourceModule: "live-execution",
    metadata: { runId: run.id, attemptId, blockedReason }
  });

  await recordLearningEventSafe({
    sellerId: action.sellerId,
    actionId: action.id,
    source: action.source,
    sourceId: action.sourceId,
    actionType: action.actionType,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    eventType: result.ok ? "ACTION_MONITORING" : "LIVE_EXECUTION_BLOCKED",
    actor,
    note: blockedReason,
    evidence: { runId: run.id, attemptId },
    metadata: { liveExecution: true, adapterConfigured: result.configured }
  });

  return {
    ok: result.ok,
    action,
    run,
    blockedReason,
    message: result.ok ? "Live execution completed." : "Live execution blocked. No external action executed."
  };
}

export async function listLiveExecutionRuns(input: {
  sellerId: string;
  limit: number;
  actionId?: string | null;
}): Promise<SafeLiveExecutionRun[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  let query = supabase
    .from("live_execution_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (input.actionId) query = query.eq("action_id", input.actionId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as LiveExecutionRunRow[]).map(toSafeLiveExecutionRun);
}

export async function getLiveExecutionForAction(actionId: string, sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  actionId: string;
  action: SafeActionLedgerRow | null;
  runs: SafeLiveExecutionRun[];
  latestRun: SafeLiveExecutionRun | null;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const action = await getActionLedgerById(actionId);
  const runs = await listLiveExecutionRuns({ sellerId, actionId: action?.id ?? actionId, limit: 100 });
  return {
    ok: true,
    sellerId,
    actionId: action?.id ?? actionId,
    action,
    runs,
    latestRun: runs[0] ?? null
  };
}
