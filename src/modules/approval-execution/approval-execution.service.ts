import { getActionLedgerById, listActionLedgerRows } from "../action-ledger/action-ledger.service";
import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { recordWorkflowEvent } from "../action-ledger/action-workflow.service";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { executeLive, executeShadow, previewExecution } from "../execution-gateway/execution-gateway.service";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { LearningEventType } from "../learning-loop/learning-loop.types";
import { getSafetyControlSnapshotSafe } from "../safety-control/safety-control.service";
import { ApprovalExecutionSummary } from "./approval-execution.types";

const SUPPORTED_ACTION_TYPES = new Set([
  "PPC_ACTION",
  "PPC_GUARDRAIL_REVIEW",
  "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
  "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
  "CHECK_LISTING_BEFORE_NEGATIVE",
  "PAUSE_OR_REDUCE_SPEND_AFTER_APPROVAL",
  "PROFIT_RISK_REVIEW",
  "PROFIT_BAND_APPROVAL",
  "LISTING_READINESS_REVIEW",
  "LISTING_SEO_REVIEW",
  "LISTING_CONVERSION_REVIEW",
  "LISTING_TITLE_DRAFT_REVIEW",
  "LISTING_BULLETS_DRAFT_REVIEW",
  "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW",
  "LISTING_DESCRIPTION_DRAFT_REVIEW",
  "IMAGE_CREATIVE_REVIEW",
  "A_PLUS_CONTENT_REVIEW",
  "PRICING_REVIEW",
  "INVENTORY_RISK_REVIEW",
  "ACCOUNT_HEALTH_REVIEW",
  "COST_DATA_REQUIRED"
]);

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function isReadyAction(action: SafeActionLedgerRow): boolean {
  return (
    action.requiresApproval === true &&
    SUPPORTED_ACTION_TYPES.has(action.actionType) &&
    (action.approvalStatus === "APPROVED" || action.state === "APPROVED" || action.state === "MONITORING" || action.approvalStatus === "MONITOR")
  );
}

async function loadReadyActions(sellerId: string, limit: number): Promise<SafeActionLedgerRow[]> {
  const [approved, monitoring] = await Promise.all([
    listActionLedgerRows({ sellerId, approvalStatus: "APPROVED", limit }),
    listActionLedgerRows({ sellerId, approvalStatus: "MONITOR", limit })
  ]);
  return [...approved, ...monitoring]
    .filter(isReadyAction)
    .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""))
    .slice(0, limit);
}

async function verifyActionForBridge(actionId: string): Promise<SafeActionLedgerRow> {
  const action = await getActionLedgerById(actionId);
  if (!action) throw new Error("ACTION_NOT_FOUND");

  if (!isReadyAction(action)) {
    throw new Error("ACTION_NOT_READY");
  }

  const safety = await getSafetyControlSnapshotSafe(action.sellerId);
  if (safety.liveExecutionEnabled !== false || safety.aiCallsEnabled !== false || action.requiresApproval !== true) {
    throw new Error("SAFETY_CHECK_FAILED");
  }

  return action;
}

async function recordBridgeActivity(input: {
  action: SafeActionLedgerRow;
  eventType: string;
  title: string;
  actor?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await safeRecordActivityLog({
    sellerId: input.action.sellerId,
    eventType: input.eventType,
    eventCategory: "APPROVAL_EXECUTION",
    severity: "INFO",
    actor: cleanText(input.actor) ?? "founder",
    title: input.title,
    message: "Approval-to-Execution Bridge delegated safely in shadow mode.",
    entityType: input.action.entityType,
    entityId: input.action.entityId,
    sku: input.action.sku,
    asin: input.action.asin,
    actionId: input.action.id,
    sourceModule: "approval-execution",
    metadata: { shadowMode: true, externalExecution: false, ...(input.metadata ?? {}) }
  });
}

async function recordBridgeSignals(input: {
  action: SafeActionLedgerRow;
  workflowEventType: string;
  learningEventType: LearningEventType;
  actor?: string | null;
  note: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await Promise.all([
    recordLearningEventSafe({
      sellerId: input.action.sellerId,
      actionId: input.action.id,
      source: input.action.source,
      sourceId: input.action.sourceId,
      actionType: input.action.actionType,
      entityType: input.action.entityType,
      entityId: input.action.entityId,
      sku: input.action.sku,
      asin: input.action.asin,
      eventType: input.learningEventType,
      actor: cleanText(input.actor) ?? "founder",
      note: input.note,
      evidence: { approvalExecutionBridge: true },
      metadata: input.metadata ?? {}
    }),
    recordWorkflowEvent({
      actionId: input.action.id,
      sellerId: input.action.sellerId,
      fromState: input.action.state,
      toState: input.action.state,
      eventType: input.workflowEventType,
      actor: cleanText(input.actor) ?? "founder",
      note: input.note,
      snapshotBefore: input.action,
      snapshotAfter: input.action,
      rollbackSnapshot: input.action.rollbackSnapshot,
      metadata: {
        approvalExecutionBridge: true,
        shadowMode: true,
        externalExecution: false,
        ...(input.metadata ?? {})
      }
    }).catch(() => null)
  ]);
}

export async function listApprovalExecutionReadyActions(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeActionLedgerRow[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
  return loadReadyActions(sellerId, limit);
}

export async function getApprovalExecutionSummary(sellerIdInput: string): Promise<ApprovalExecutionSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const ready = await loadReadyActions(sellerId, 100);
  return {
    ok: true,
    sellerId,
    readyCount: ready.length,
    approvedCount: ready.filter((row) => row.approvalStatus === "APPROVED" || row.state === "APPROVED").length,
    monitoringCount: ready.filter((row) => row.approvalStatus === "MONITOR" || row.state === "MONITORING").length,
    liveExecutionEnabled: false,
    aiCallsEnabled: false,
    latestReadyActions: ready.slice(0, 10),
    message: "Approved actions are ready for preview or shadow execution only. Live execution remains blocked."
  };
}

export async function previewApprovedAction(input: {
  actionId: string;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
}): Promise<unknown> {
  const action = await verifyActionForBridge(input.actionId);
  await recordBridgeActivity({ action, eventType: "APPROVAL_EXECUTION_PREVIEW_REQUESTED", title: "Approved action preview requested", actor: input.actor });
  const result = await previewExecution(input);
  await recordBridgeSignals({
    action,
    workflowEventType: "APPROVAL_EXECUTION_PREVIEWED",
    learningEventType: "SHADOW_EXECUTION_PREVIEWED",
    actor: input.actor,
    note: "Approved action previewed through Execution Gateway.",
    metadata: { result }
  });
  return result;
}

export async function shadowExecuteApprovedAction(input: {
  actionId: string;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
}): Promise<unknown> {
  const action = await verifyActionForBridge(input.actionId);
  await recordBridgeActivity({ action, eventType: "APPROVAL_EXECUTION_SHADOW_REQUESTED", title: "Approved action shadow execution requested", actor: input.actor });
  const result = await executeShadow(input);
  await recordBridgeSignals({
    action,
    workflowEventType: "APPROVAL_EXECUTION_SHADOW_COMPLETED",
    learningEventType: "SHADOW_EXECUTION_COMPLETED",
    actor: input.actor,
    note: "Approved action delegated to shadow execution. No external action executed.",
    metadata: { result }
  });
  return result;
}

export async function liveExecuteApprovedAction(input: {
  actionId: string;
  actor?: string | null;
  requestPayload?: Record<string, unknown>;
}): Promise<unknown> {
  const action = await verifyActionForBridge(input.actionId);
  await recordBridgeActivity({
    action,
    eventType: "APPROVAL_EXECUTION_LIVE_BLOCKED",
    title: "Approved action live execution blocked",
    actor: input.actor,
    metadata: { liveExecutionEnabled: false }
  });
  const result = await executeLive(input);
  await recordBridgeSignals({
    action,
    workflowEventType: "APPROVAL_EXECUTION_LIVE_BLOCKED",
    learningEventType: "LIVE_EXECUTION_BLOCKED",
    actor: input.actor,
    note: "Live execution was blocked by the Approval-to-Execution Bridge.",
    metadata: { result, liveExecutionEnabled: false }
  });
  return result;
}
