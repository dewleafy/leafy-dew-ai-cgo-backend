import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ActionLedgerApprovalStatus,
  ActionLedgerRow,
  ActionLedgerState,
  SafeActionLedgerRow
} from "./action-ledger.types";
import { toSafeActionLedgerRow } from "./action-ledger.service";

export const INVALID_WORKFLOW_TRANSITION_MESSAGE = "Invalid workflow transition";

export class InvalidWorkflowTransitionError extends Error {
  constructor() {
    super(INVALID_WORKFLOW_TRANSITION_MESSAGE);
  }
}

type JsonObject = Record<string, unknown>;

type ActionWorkflowEventRow = {
  id: string;
  action_id: string;
  seller_id: string;
  from_state: string | null;
  to_state: string;
  event_type: string;
  actor: string;
  note: string | null;
  snapshot_before: JsonObject | null;
  snapshot_after: JsonObject | null;
  rollback_snapshot: JsonObject | null;
  metadata: JsonObject;
  created_at: string | null;
};

export type SafeActionWorkflowEvent = {
  id: string;
  actionId: string;
  sellerId: string;
  fromState: string | null;
  toState: string;
  eventType: string;
  actor: string;
  note: string | null;
  snapshotBefore: JsonObject | null;
  snapshotAfter: JsonObject | null;
  rollbackSnapshot: JsonObject | null;
  metadata: JsonObject;
  createdAt: string | null;
};

export type WorkflowTransitionResult = {
  row: SafeActionLedgerRow;
  event: SafeActionWorkflowEvent;
};

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function canonicalizeActionId(input: unknown): string {
  return String(input || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function toJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function toNullableJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function toWorkflowEvent(row: ActionWorkflowEventRow): SafeActionWorkflowEvent {
  return {
    id: row.id,
    actionId: row.action_id,
    sellerId: row.seller_id,
    fromState: row.from_state,
    toState: row.to_state,
    eventType: row.event_type,
    actor: row.actor,
    note: row.note,
    snapshotBefore: toNullableJsonObject(row.snapshot_before),
    snapshotAfter: toNullableJsonObject(row.snapshot_after),
    rollbackSnapshot: toNullableJsonObject(row.rollback_snapshot),
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

function isFounder(actor: string): boolean {
  return actor.trim().toLowerCase() === "founder";
}

function isSystem(actor: string): boolean {
  return actor.trim().toLowerCase() === "system";
}

function isAllowedTransition(input: {
  fromState: string;
  toState: ActionLedgerState;
  eventType: string;
  actor: string;
}): boolean {
  const fromState = input.fromState;
  const toState = input.toState;
  const eventType = input.eventType.toUpperCase();

  if (eventType === "REOPEN") {
    return isFounder(input.actor) && (fromState === "REJECTED" || fromState === "COMPLETED") && toState === "WAITING_FOR_APPROVAL";
  }

  if (fromState === "COMPLETED") return false;

  if (eventType === "COST_DATA_COMPLETED_AUTO_RESOLVE") {
    return isSystem(input.actor) && fromState === "WAITING_FOR_APPROVAL" && toState === "COMPLETED";
  }

  const allowedTransitions: Record<string, string[]> = {
    WAITING_FOR_APPROVAL: ["APPROVED", "REJECTED", "MONITORING"],
    APPROVED: ["MONITORING", "COMPLETED"],
    MONITORING: ["COMPLETED"],
    MONITOR: ["COMPLETED"]
  };

  return allowedTransitions[fromState]?.includes(toState) ?? false;
}

function approvalStatusForState(state: ActionLedgerState): ActionLedgerApprovalStatus {
  if (state === "APPROVED") return "APPROVED";
  if (state === "REJECTED") return "REJECTED";
  if (state === "MONITORING" || state === "MONITOR") return "MONITOR";
  if (state === "COMPLETED") return "COMPLETED";
  return "PENDING";
}

function logWorkflowError(context: string, error: { message?: string; code?: string; details?: string; hint?: string }): void {
  logger.warn(context, {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint
  });
}

async function getActionLedgerRowForWorkflow(input: {
  actionId: string;
  sellerId: string;
}): Promise<ActionLedgerRow | null> {
  const actionId = canonicalizeActionId(input.actionId);
  const sellerId = cleanText(input.sellerId) ?? "default";

  if (!actionId) return null;

  const { data, error } = await supabase
    .from("action_ledger")
    .select("*")
    .eq("id", actionId)
    .eq("seller_id", sellerId)
    .maybeSingle<ActionLedgerRow>();

  if (error) {
    logWorkflowError("Could not load action row for workflow.", error);
    throw new Error("Could not load action workflow row from Supabase.");
  }

  return data ?? null;
}

export async function loadActionRowsForWorkflow(input: {
  sellerId: string;
  ids: string[];
}): Promise<ActionLedgerRow[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const ids = [...new Set(input.ids.map(canonicalizeActionId).filter(Boolean))];

  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("action_ledger")
    .select("*")
    .eq("seller_id", sellerId)
    .in("id", ids);

  if (error) {
    logWorkflowError("Could not load action workflow snapshots.", error);
    throw new Error("Could not load action workflow snapshots from Supabase.");
  }

  return (data ?? []) as ActionLedgerRow[];
}

export async function recordWorkflowEvent(input: {
  actionId: string;
  sellerId?: string;
  fromState?: string | null;
  toState: string;
  eventType: string;
  actor?: string | null;
  note?: string | null;
  snapshotBefore?: unknown;
  snapshotAfter?: unknown;
  rollbackSnapshot?: unknown;
  metadata?: JsonObject;
}): Promise<SafeActionWorkflowEvent> {
  const { data, error } = await supabase
    .from("action_workflow_events")
    .insert({
      action_id: canonicalizeActionId(input.actionId),
      seller_id: cleanText(input.sellerId) ?? "default",
      from_state: cleanText(input.fromState),
      to_state: cleanText(input.toState) ?? "UNKNOWN",
      event_type: cleanText(input.eventType) ?? "UNKNOWN",
      actor: cleanText(input.actor) ?? "system",
      note: cleanText(input.note),
      snapshot_before: toNullableJsonObject(input.snapshotBefore),
      snapshot_after: toNullableJsonObject(input.snapshotAfter),
      rollback_snapshot: toNullableJsonObject(input.rollbackSnapshot),
      metadata: toJsonObject(input.metadata)
    })
    .select("*")
    .single<ActionWorkflowEventRow>();

  if (error || !data) {
    if (error) logWorkflowError("Could not record action workflow event.", error);
    throw new Error("Could not record action workflow event in Supabase.");
  }

  return toWorkflowEvent(data);
}

export async function getWorkflowEvents(actionIdInput: string, sellerIdInput: string): Promise<SafeActionWorkflowEvent[]> {
  const actionId = canonicalizeActionId(actionIdInput);
  const sellerId = cleanText(sellerIdInput) ?? "default";

  if (!actionId) return [];

  const { data, error } = await supabase
    .from("action_workflow_events")
    .select("*")
    .eq("action_id", actionId)
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: true });

  if (error) {
    logWorkflowError("Could not load action workflow events.", error);
    throw new Error("Could not load action workflow events from Supabase.");
  }

  return ((data ?? []) as ActionWorkflowEventRow[]).map(toWorkflowEvent);
}

export async function transitionActionState(input: {
  actionId: string;
  sellerId: string;
  toState: ActionLedgerState;
  approvalStatus?: ActionLedgerApprovalStatus;
  eventType: string;
  actor?: string | null;
  note?: string | null;
  metadata?: JsonObject;
}): Promise<WorkflowTransitionResult | null> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const actor = cleanText(input.actor) ?? "system";
  const before = await getActionLedgerRowForWorkflow({ actionId: input.actionId, sellerId });

  if (!before) return null;

  if (!isAllowedTransition({
    fromState: before.state,
    toState: input.toState,
    eventType: input.eventType,
    actor
  })) {
    throw new InvalidWorkflowTransitionError();
  }

  const now = new Date().toISOString();
  const approvalStatus = input.approvalStatus ?? approvalStatusForState(input.toState);
  const updateRow: Record<string, unknown> = {
    state: input.toState,
    approval_status: approvalStatus,
    approval_note: cleanText(input.note),
    updated_at: now
  };

  if (input.toState === "APPROVED") {
    updateRow.approved_at = now;
    updateRow.approved_by = actor;
  }

  if (input.toState === "REJECTED") {
    updateRow.rejected_at = now;
  }

  if (input.toState === "MONITORING" || input.toState === "COMPLETED") {
    updateRow.approved_by = before.approved_by ?? actor;
  }

  if (input.toState === "WAITING_FOR_APPROVAL") {
    updateRow.approved_by = null;
    updateRow.approved_at = null;
    updateRow.rejected_at = null;
  }

  const { data, error } = await supabase
    .from("action_ledger")
    .update(updateRow)
    .eq("id", before.id)
    .eq("seller_id", sellerId)
    .select("*")
    .maybeSingle<ActionLedgerRow>();

  if (error) {
    logWorkflowError("Could not transition action workflow state.", error);
    throw new Error("Could not transition action workflow state in Supabase.");
  }

  if (!data) return null;

  const event = await recordWorkflowEvent({
    actionId: data.id,
    sellerId,
    fromState: before.state,
    toState: data.state,
    eventType: input.eventType,
    actor,
    note: input.note,
    snapshotBefore: before,
    snapshotAfter: data,
    rollbackSnapshot: data.rollback_snapshot ?? before.rollback_snapshot,
    metadata: {
      shadowMode: true,
      externalExecution: false,
      ...(input.metadata ?? {})
    }
  });

  return {
    row: toSafeActionLedgerRow(data),
    event
  };
}

export async function recordWorkflowEventsForUpdatedRows(input: {
  sellerId: string;
  beforeRows: ActionLedgerRow[];
  afterRows: SafeActionLedgerRow[];
  eventType: string;
  actor?: string | null;
  note?: string | null;
  metadata?: JsonObject;
}): Promise<SafeActionWorkflowEvent[]> {
  const beforeById = new Map(input.beforeRows.map((row) => [row.id, row]));
  const events: SafeActionWorkflowEvent[] = [];

  for (const afterRow of input.afterRows) {
    const before = beforeById.get(afterRow.id);

    events.push(await recordWorkflowEvent({
      actionId: afterRow.id,
      sellerId: input.sellerId,
      fromState: before?.state ?? null,
      toState: afterRow.state,
      eventType: input.eventType,
      actor: input.actor,
      note: input.note,
      snapshotBefore: before ?? null,
      snapshotAfter: afterRow,
      rollbackSnapshot: afterRow.rollbackSnapshot ?? before?.rollback_snapshot ?? null,
      metadata: {
        shadowMode: true,
        externalExecution: false,
        ...(input.metadata ?? {})
      }
    }));
  }

  return events;
}

export async function getRollbackPreview(input: {
  actionId: string;
  sellerId: string;
}): Promise<{
  actionId: string;
  sellerId: string;
  canRollback: boolean;
  rollbackSnapshot: JsonObject | null;
  message: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const action = await getActionLedgerRowForWorkflow({ actionId: input.actionId, sellerId });
  const actionId = canonicalizeActionId(input.actionId);

  if (!action) {
    return {
      actionId,
      sellerId,
      canRollback: false,
      rollbackSnapshot: null,
      message: "Action ledger row not found."
    };
  }

  const actionRollbackSnapshot = toNullableJsonObject(action.rollback_snapshot);
  if (actionRollbackSnapshot) {
    return {
      actionId: action.id,
      sellerId,
      canRollback: true,
      rollbackSnapshot: actionRollbackSnapshot,
      message: "Rollback snapshot is available from action ledger."
    };
  }

  const { data, error } = await supabase
    .from("action_workflow_events")
    .select("*")
    .eq("action_id", action.id)
    .eq("seller_id", sellerId)
    .not("rollback_snapshot", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    logWorkflowError("Could not load action rollback preview.", error);
    throw new Error("Could not load action rollback preview from Supabase.");
  }

  const latestEvent = ((data ?? []) as ActionWorkflowEventRow[])[0];
  const rollbackSnapshot = toNullableJsonObject(latestEvent?.rollback_snapshot);

  return {
    actionId: action.id,
    sellerId,
    canRollback: Boolean(rollbackSnapshot),
    rollbackSnapshot,
    message: rollbackSnapshot
      ? "Rollback snapshot is available from workflow history."
      : "No rollback snapshot is available. No rollback was executed."
  };
}

export async function backfillWorkflowEvents(input: {
  sellerId: string;
}): Promise<{
  sellerId: string;
  scannedCount: number;
  createdCount: number;
  skippedCount: number;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const pageSize = 500;
  let scannedCount = 0;
  let createdCount = 0;
  let skippedCount = 0;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("action_ledger")
      .select("*")
      .eq("seller_id", sellerId)
      .order("created_at", { ascending: true })
      .range(from, to);

    if (error) {
      logWorkflowError("Could not load action ledger rows for workflow backfill.", error);
      throw new Error("Could not load action ledger rows for workflow backfill from Supabase.");
    }

    const rows = (data ?? []) as ActionLedgerRow[];
    scannedCount += rows.length;

    if (!rows.length) break;

    const ids = rows.map((row) => row.id);
    const { data: existingEvents, error: eventError } = await supabase
      .from("action_workflow_events")
      .select("action_id")
      .eq("seller_id", sellerId)
      .in("action_id", ids);

    if (eventError) {
      logWorkflowError("Could not load existing workflow events for backfill.", eventError);
      throw new Error("Could not load existing workflow events for backfill from Supabase.");
    }

    const existingActionIds = new Set(((existingEvents ?? []) as Array<{ action_id: string }>).map((event) => event.action_id));
    const rowsToCreate = rows.filter((row) => !existingActionIds.has(row.id));
    skippedCount += rows.length - rowsToCreate.length;

    if (rowsToCreate.length) {
      const { error: insertError } = await supabase
        .from("action_workflow_events")
        .insert(rowsToCreate.map((row) => ({
          action_id: row.id,
          seller_id: sellerId,
          from_state: null,
          to_state: row.state,
          event_type: "INITIAL_STATE_CAPTURE",
          actor: "system",
          note: null,
          snapshot_before: null,
          snapshot_after: row,
          rollback_snapshot: row.rollback_snapshot,
          metadata: {
            shadowMode: true,
            externalExecution: false,
            backfill: true
          }
        })));

      if (insertError) {
        logWorkflowError("Could not create workflow backfill events.", insertError);
        throw new Error("Could not create workflow backfill events in Supabase.");
      }

      createdCount += rowsToCreate.length;
    }

    if (rows.length < pageSize) break;
  }

  return {
    sellerId,
    scannedCount,
    createdCount,
    skippedCount
  };
}
