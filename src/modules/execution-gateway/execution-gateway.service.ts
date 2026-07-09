import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { recordWorkflowEvent } from "../action-ledger/action-workflow.service";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ExecutionAttemptRow,
  ExecutionMode,
  ExecutionSafetyChecks,
  ExecutionStatus,
  SafeExecutionAttempt
} from "./execution-gateway.types";

export const EXECUTION_SAFETY_CHECKS: ExecutionSafetyChecks = {
  shadowMode: true,
  externalExecution: false,
  liveExecutionEnabled: false,
  amazonUpdate: false,
  adsUpdate: false,
  listingUpdate: false,
  imageUpload: false,
  aPlusUpload: false,
  socialPost: false,
  aiCall: false,
  aiCallsEnabled: false,
  approvalRequired: true,
  safetyControl: {
    shadowMode: true,
    liveExecutionEnabled: false,
    aiCallsEnabled: false,
    message: "Live execution remains blocked in V1."
  }
};

const SUPPORTED_SHADOW_ACTION_TYPES = new Set([
  "PPC_GUARDRAIL_REVIEW",
  "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
  "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
  "CHECK_LISTING_BEFORE_NEGATIVE",
  "PROFIT_RISK_REVIEW",
  "COST_DATA_REQUIRED",
  "LISTING_READINESS_REVIEW",
  "LISTING_SEO_REVIEW",
  "LISTING_CONVERSION_REVIEW",
  "ACCOUNT_HEALTH_REVIEW",
  "PRICING_REVIEW",
  "INVENTORY_RISK_REVIEW",
  "LISTING_TITLE_DRAFT_REVIEW",
  "LISTING_BULLETS_DRAFT_REVIEW",
  "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW",
  "LISTING_DESCRIPTION_DRAFT_REVIEW",
  "IMAGE_CREATIVE_REVIEW",
  "A_PLUS_CONTENT_REVIEW"
]);

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

async function buildExecutionSafetyChecks(sellerId: string): Promise<ExecutionSafetyChecks> {
  const safetySnapshot = await getSafetyControlSnapshotSafe(sellerId);
  return {
    ...EXECUTION_SAFETY_CHECKS,
    liveExecutionEnabled: false,
    aiCallsEnabled: false,
    approvalRequired: true,
    safetyControl: safetySnapshot as unknown as Record<string, unknown>
  };
}

function toSafeAttempt(row: ExecutionAttemptRow): SafeExecutionAttempt {
  return {
    id: row.id,
    sellerId: row.seller_id,
    actionId: row.action_id,
    source: row.source,
    sourceId: row.source_id,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    executionMode: row.execution_mode,
    executionStatus: row.execution_status,
    actor: row.actor,
    requestPayload: toJsonObject(row.request_payload),
    plannedChange: toJsonObject(row.planned_change),
    snapshotBefore: toNullableJsonObject(row.snapshot_before),
    snapshotAfter: toNullableJsonObject(row.snapshot_after),
    rollbackSnapshot: toNullableJsonObject(row.rollback_snapshot),
    safetyChecks: toJsonObject(row.safety_checks),
    blockedReason: row.blocked_reason,
    resultMessage: row.result_message,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at
  };
}

function plannedChangeForAction(action: SafeActionLedgerRow): Record<string, unknown> {
  const common = {
    actionId: action.id,
    actionType: action.actionType,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    title: action.title,
    summary: action.summary,
    recommendedAction: action.recommendedAction,
    supported: SUPPORTED_SHADOW_ACTION_TYPES.has(action.actionType),
    externalExecution: false,
    shadowOnly: true
  };

  if (action.actionType.includes("LISTING") || action.actionType.includes("IMAGE") || action.actionType.includes("A_PLUS")) {
    return {
      ...common,
      previewKind: "CONTENT_REVIEW",
      proposedPayload: action.payload,
      listingUpdate: false,
      imageUpload: false,
      aPlusUpload: false
    };
  }

  if (action.actionType.includes("PPC") || action.actionType.includes("KEYWORD") || action.actionType.includes("TARGET")) {
    return {
      ...common,
      previewKind: "ADS_REVIEW",
      adsUpdate: false,
      proposedPayload: action.payload
    };
  }

  return {
    ...common,
    previewKind: "SAFE_REVIEW",
    proposedPayload: action.payload
  };
}

async function createAttempt(input: {
  action: SafeActionLedgerRow;
  executionMode: ExecutionMode;
  executionStatus: ExecutionStatus;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
  plannedChange?: Record<string, unknown>;
  snapshotBefore?: Record<string, unknown> | null;
  snapshotAfter?: Record<string, unknown> | null;
  rollbackSnapshot?: Record<string, unknown> | null;
  blockedReason?: string | null;
  resultMessage?: string | null;
  errorMessage?: string | null;
}): Promise<SafeExecutionAttempt> {
  const now = new Date().toISOString();
  const safetyChecks = await buildExecutionSafetyChecks(input.action.sellerId);
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
      execution_mode: input.executionMode,
      execution_status: input.executionStatus,
      actor: cleanText(input.actor) ?? "founder",
      request_payload: input.requestPayload ?? {},
      planned_change: input.plannedChange ?? plannedChangeForAction(input.action),
      snapshot_before: input.snapshotBefore ?? input.action,
      snapshot_after: input.snapshotAfter ?? null,
      rollback_snapshot: input.rollbackSnapshot ?? input.action.rollbackSnapshot,
      safety_checks: safetyChecks,
      blocked_reason: cleanText(input.blockedReason),
      result_message: cleanText(input.resultMessage),
      error_message: cleanText(input.errorMessage),
      finished_at: now
    })
    .select("*")
    .single<ExecutionAttemptRow>();

  if (error || !data) {
    throw new Error(error?.message ?? "Could not create execution attempt.");
  }

  return toSafeAttempt(data);
}

async function loadAction(actionId: string): Promise<SafeActionLedgerRow | null> {
  return getActionLedgerById(actionId);
}

function isApprovedForShadowExecution(action: SafeActionLedgerRow): boolean {
  return action.approvalStatus === "APPROVED" || action.state === "APPROVED" || action.state === "MONITORING";
}

export async function getExecutionGatewayStatus(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  mode: "SHADOW_ONLY";
  liveExecutionEnabled: false;
  aiCallsEnabled: false;
  safety: Record<string, unknown>;
  message: string;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const safety = await getSafetyControlSnapshotSafe(sellerId);
  return {
    ok: true,
    sellerId,
    mode: "SHADOW_ONLY",
    liveExecutionEnabled: false,
    aiCallsEnabled: false,
    safety: safety as unknown as Record<string, unknown>,
    message: "Live execution is blocked. Shadow execution only."
  };
}

export async function previewExecution(input: {
  actionId: string;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
}): Promise<{ ok: true; action: SafeActionLedgerRow; attempt: SafeExecutionAttempt; preview: Record<string, unknown>; safetyChecks: ExecutionSafetyChecks }> {
  const action = await loadAction(input.actionId);
  if (!action) throw new Error("ACTION_NOT_FOUND");

  const preview = plannedChangeForAction(action);
  const attempt = await createAttempt({
    action,
    executionMode: "SHADOW",
    executionStatus: "PREVIEW_CREATED",
    actor: input.actor,
    requestPayload: input.requestPayload,
    plannedChange: preview,
    resultMessage: "Shadow preview created. No external action executed."
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
    eventType: "SHADOW_EXECUTION_PREVIEWED",
    actor: cleanText(input.actor) ?? "founder",
    evidence: { attemptId: attempt.id },
    metadata: { executionGateway: true }
  });

  return { ok: true, action, attempt, preview, safetyChecks: attempt.safetyChecks as ExecutionSafetyChecks };
}

export async function executeShadow(input: {
  actionId: string;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
}): Promise<{
  ok: boolean;
  executionMode: "SHADOW";
  externalExecution: false;
  message: string;
  action?: SafeActionLedgerRow;
  attempt?: SafeExecutionAttempt;
}> {
  const action = await loadAction(input.actionId);
  if (!action) throw new Error("ACTION_NOT_FOUND");

  if (!isApprovedForShadowExecution(action)) {
    const attempt = await createAttempt({
      action,
      executionMode: "SHADOW",
      executionStatus: "APPROVAL_REQUIRED",
      actor: input.actor,
      requestPayload: input.requestPayload,
      blockedReason: "Action must be approved or monitoring before shadow execution.",
      resultMessage: "Shadow execution blocked until approval."
    });
    return {
      ok: false,
      executionMode: "SHADOW",
      externalExecution: false,
      message: "Action must be approved before shadow execution.",
      action,
      attempt
    };
  }

  if (!SUPPORTED_SHADOW_ACTION_TYPES.has(action.actionType)) {
    const attempt = await createAttempt({
      action,
      executionMode: "SHADOW",
      executionStatus: "EXECUTION_NOT_IMPLEMENTED",
      actor: input.actor,
      requestPayload: input.requestPayload,
      resultMessage: "Execution is not implemented for this action type in V1. No external action executed."
    });
    return {
      ok: false,
      executionMode: "SHADOW",
      externalExecution: false,
      message: "EXECUTION_NOT_IMPLEMENTED",
      action,
      attempt
    };
  }

  const plannedChange = plannedChangeForAction(action);
  const attempt = await createAttempt({
    action,
    executionMode: "SHADOW",
    executionStatus: "SHADOW_COMPLETED",
    actor: input.actor,
    requestPayload: input.requestPayload,
    plannedChange,
    snapshotAfter: {
      ...action,
      shadowExecution: {
        completedAt: new Date().toISOString(),
        externalExecution: false
      }
    },
    resultMessage: "Shadow execution completed. No external action executed."
  });

  await recordWorkflowEvent({
    actionId: action.id,
    sellerId: action.sellerId,
    fromState: action.state,
    toState: action.state,
    eventType: "SHADOW_EXECUTION_COMPLETED",
    actor: cleanText(input.actor) ?? "founder",
    note: "Shadow execution completed. No external action executed.",
    snapshotBefore: action,
    snapshotAfter: { action, attempt },
    rollbackSnapshot: action.rollbackSnapshot,
    metadata: { executionGateway: true, attemptId: attempt.id }
  }).catch((error) => {
    logger.warn("Could not record workflow event for shadow execution.", {
      actionId: action.id,
      message: error instanceof Error ? error.message : "Unknown workflow error"
    });
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
    eventType: "SHADOW_EXECUTION_COMPLETED",
    actor: cleanText(input.actor) ?? "founder",
    evidence: { attemptId: attempt.id },
    metadata: { executionGateway: true }
  });

  return {
    ok: true,
    executionMode: "SHADOW",
    externalExecution: false,
    message: "Shadow execution completed. No external action executed.",
    action,
    attempt
  };
}

export async function executeLive(input: {
  actionId: string;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
}): Promise<{ ok: false; message: string; action: SafeActionLedgerRow; attempt: SafeExecutionAttempt }> {
  const action = await loadAction(input.actionId);
  if (!action) throw new Error("ACTION_NOT_FOUND");

  const attempt = await createAttempt({
    action,
    executionMode: "LIVE",
    executionStatus: "LIVE_BLOCKED",
    actor: input.actor,
    requestPayload: input.requestPayload,
    blockedReason: "Live execution is disabled in V1. Shadow mode only.",
    resultMessage: "Live execution blocked. No external action executed."
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
    actor: cleanText(input.actor) ?? "founder",
    evidence: { attemptId: attempt.id },
    metadata: { executionGateway: true, liveExecutionEnabled: false }
  });

  return {
    ok: false,
    message: "Live execution is disabled in V1. Shadow mode only.",
    action,
    attempt
  };
}

export async function listExecutionAttempts(input: {
  sellerId: string;
  limit: number;
  actionId?: string;
}): Promise<SafeExecutionAttempt[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
  let query = supabase
    .from("execution_attempts")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.actionId) query = query.eq("action_id", input.actionId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as ExecutionAttemptRow[]).map(toSafeAttempt);
}
