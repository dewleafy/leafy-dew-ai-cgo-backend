import { supabase } from "../../db/supabase";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { RollbackSnapshotRow, RollbackSummary, SafeRollbackSnapshot } from "./rollback.types";

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

function toSafeSnapshot(row: RollbackSnapshotRow): SafeRollbackSnapshot {
  return {
    id: row.id,
    sellerId: row.seller_id,
    actionId: row.action_id,
    executionAttemptId: row.execution_attempt_id,
    sourceModule: row.source_module,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    snapshotType: row.snapshot_type,
    snapshotStatus: row.snapshot_status,
    beforeState: toJsonObject(row.before_state),
    plannedChange: toJsonObject(row.planned_change),
    afterState: toNullableJsonObject(row.after_state),
    rollbackPlan: toJsonObject(row.rollback_plan),
    rollbackStatus: row.rollback_status,
    capturedBy: row.captured_by,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function plannedChangeForAction(action: SafeActionLedgerRow): Record<string, unknown> {
  return {
    actionId: action.id,
    actionType: action.actionType,
    title: action.title,
    recommendedAction: action.recommendedAction,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    payload: action.payload,
    guardrails: action.guardrails,
    shadowMode: true,
    externalExecution: false
  };
}

function rollbackPlanForAction(action: SafeActionLedgerRow, plannedChange: Record<string, unknown>): Record<string, unknown> {
  return {
    actionId: action.id,
    actionType: action.actionType,
    previewOnly: true,
    externalExecution: false,
    rollbackExecutionEnabled: false,
    message: "Rollback execution is blocked in V1. Preview only.",
    restoreFrom: {
      actionState: action.state,
      approvalStatus: action.approvalStatus,
      payload: action.payload,
      rollbackSnapshot: action.rollbackSnapshot
    },
    plannedChange
  };
}

async function countSnapshots(input: {
  sellerId: string;
  snapshotStatus?: string;
  rollbackStatus?: string;
}): Promise<number> {
  let query = supabase
    .from("rollback_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId);

  if (input.snapshotStatus) query = query.eq("snapshot_status", input.snapshotStatus);
  if (input.rollbackStatus) query = query.eq("rollback_status", input.rollbackStatus);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function listRollbackSnapshots(input: {
  sellerId: string;
  limit: number;
  actionId?: string | null;
}): Promise<SafeRollbackSnapshot[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  let query = supabase
    .from("rollback_snapshots")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.actionId) query = query.eq("action_id", input.actionId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as RollbackSnapshotRow[]).map(toSafeSnapshot);
}

export async function getRollbackSummary(sellerIdInput: string): Promise<RollbackSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [totalSnapshots, capturedCount, failedCount, executedCount, notExecutedCount, latestSnapshots] = await Promise.all([
    countSnapshots({ sellerId }),
    countSnapshots({ sellerId, snapshotStatus: "CAPTURED" }),
    countSnapshots({ sellerId, snapshotStatus: "FAILED" }),
    countSnapshots({ sellerId, rollbackStatus: "EXECUTED" }),
    countSnapshots({ sellerId, rollbackStatus: "NOT_EXECUTED" }),
    listRollbackSnapshots({ sellerId, limit: 10 })
  ]);

  return {
    ok: true,
    sellerId,
    totalSnapshots,
    capturedCount,
    failedCount,
    executedCount,
    notExecutedCount,
    latestSnapshots
  };
}

export async function getRollbackSnapshotById(snapshotIdInput: string): Promise<SafeRollbackSnapshot | null> {
  const snapshotId = cleanText(snapshotIdInput);
  if (!snapshotId) return null;

  const { data, error } = await supabase
    .from("rollback_snapshots")
    .select("*")
    .eq("id", snapshotId)
    .maybeSingle<RollbackSnapshotRow>();

  if (error) throw new Error(error.message);
  return data ? toSafeSnapshot(data) : null;
}

export async function captureRollbackSnapshot(input: {
  actionId: string;
  sellerId?: string | null;
  executionAttemptId?: string | null;
  sourceModule?: string | null;
  capturedBy?: string | null;
  plannedChange?: Record<string, unknown>;
  notes?: string | null;
}): Promise<{ ok: true; sellerId: string; snapshot: SafeRollbackSnapshot; rollbackPlan: Record<string, unknown> }> {
  const action = await getActionLedgerById(input.actionId);
  if (!action) throw new Error("ACTION_NOT_FOUND");

  const sellerId = cleanText(input.sellerId) ?? action.sellerId;
  const plannedChange = input.plannedChange ?? plannedChangeForAction(action);
  const rollbackPlan = rollbackPlanForAction(action, plannedChange);
  const { data, error } = await supabase
    .from("rollback_snapshots")
    .insert({
      seller_id: sellerId,
      action_id: action.id,
      execution_attempt_id: cleanText(input.executionAttemptId),
      source_module: cleanText(input.sourceModule) ?? action.source ?? "ACTION_LEDGER",
      entity_type: action.entityType,
      entity_id: action.entityId,
      sku: action.sku,
      asin: action.asin,
      snapshot_type: "PRE_CHANGE",
      snapshot_status: "CAPTURED",
      before_state: action,
      planned_change: plannedChange,
      after_state: null,
      rollback_plan: rollbackPlan,
      rollback_status: "NOT_EXECUTED",
      captured_by: cleanText(input.capturedBy) ?? "system",
      notes: cleanText(input.notes)
    })
    .select("*")
    .single<RollbackSnapshotRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not capture rollback snapshot.");

  const snapshot = toSafeSnapshot(data);
  await safeRecordActivityLog({
    sellerId,
    eventType: "ROLLBACK_SNAPSHOT_CAPTURED",
    eventCategory: "ROLLBACK",
    severity: "INFO",
    actor: cleanText(input.capturedBy) ?? "system",
    title: "Rollback snapshot captured",
    message: "A pre-change rollback snapshot was captured in shadow mode.",
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    actionId: action.id,
    sourceModule: "rollback",
    metadata: { snapshotId: snapshot.id, externalExecution: false }
  });

  return { ok: true, sellerId, snapshot, rollbackPlan };
}

export async function captureRollbackSnapshotSafe(input: {
  actionId: string;
  sellerId?: string | null;
  executionAttemptId?: string | null;
  sourceModule?: string | null;
  capturedBy?: string | null;
  plannedChange?: Record<string, unknown>;
  notes?: string | null;
}): Promise<SafeRollbackSnapshot | null> {
  try {
    const result = await captureRollbackSnapshot(input);
    return result.snapshot;
  } catch {
    return null;
  }
}

export async function previewRollbackSnapshot(snapshotId: string): Promise<{
  ok: true;
  snapshot: SafeRollbackSnapshot;
  rollbackPlan: Record<string, unknown>;
  message: string;
}> {
  const snapshot = await getRollbackSnapshotById(snapshotId);
  if (!snapshot) throw new Error("SNAPSHOT_NOT_FOUND");

  return {
    ok: true,
    snapshot,
    rollbackPlan: snapshot.rollbackPlan,
    message: "Rollback preview generated. No external action executed."
  };
}

export async function executeRollbackSnapshot(snapshotId: string): Promise<{
  ok: false;
  snapshotId: string;
  message: "Rollback execution is blocked in V1. Preview only.";
}> {
  return {
    ok: false,
    snapshotId,
    message: "Rollback execution is blocked in V1. Preview only."
  };
}
