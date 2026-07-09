import { supabase } from "../../db/supabase";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import {
  ExperimentEventRow,
  ExperimentInput,
  ExperimentPriority,
  ExperimentResultStatus,
  ExperimentRow,
  ExperimentStatus,
  ExperimentType,
  ExperimentUpdateInput,
  SafeExperimentEvent,
  SafeExperimentRow
} from "./experiments.types";

export const EXPERIMENT_TYPES: ExperimentType[] = [
  "PPC_BID_TEST",
  "PPC_KEYWORD_TEST",
  "LISTING_TITLE_TEST",
  "LISTING_IMAGE_TEST",
  "PRICING_TEST",
  "COUPON_TEST",
  "CONTENT_A_PLUS_TEST",
  "INVENTORY_REPLENISHMENT_TEST",
  "PPC_PRODUCT_TARGET_TEST",
  "LISTING_CONTENT_TEST",
  "IMAGE_TEST",
  "PRICE_TEST",
  "BUNDLE_TEST",
  "BRAND_CONTENT_TEST",
  "OTHER"
];

export const EXPERIMENT_STATUSES: ExperimentStatus[] = ["DRAFT", "RUNNING", "COMPLETED", "CANCELLED", "PLANNED", "ACTIVE", "PAUSED", "FAILED"];
export const EXPERIMENT_RESULT_STATUSES: ExperimentResultStatus[] = ["WON", "LOST", "INCONCLUSIVE"];
export const EXPERIMENT_PRIORITIES: ExperimentPriority[] = ["LOW", "MEDIUM", "HIGH"];

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function emptyJson(value: unknown): boolean {
  return Object.keys(toJsonObject(value)).length === 0;
}

function toSafeExperiment(row: ExperimentRow): SafeExperimentRow {
  const name = cleanText(row.name) ?? cleanText(row.experiment_name) ?? "Untitled experiment";
  const baselineMetrics = emptyJson(row.baseline_metrics) ? toJsonObject(row.before_metrics) : toJsonObject(row.baseline_metrics);
  const currentMetrics = emptyJson(row.current_metrics) ? toJsonObject(row.after_metrics) : toJsonObject(row.current_metrics);

  return {
    id: row.id,
    sellerId: row.seller_id,
    experimentKey: row.experiment_key,
    name,
    experimentName: name,
    description: row.description,
    experimentType: row.experiment_type,
    status: row.status,
    actionId: row.action_id,
    engineKey: row.engine_key,
    sku: row.sku,
    asin: row.asin,
    hypothesis: row.hypothesis,
    baselineMetrics,
    targetMetrics: toJsonObject(row.target_metrics),
    currentMetrics,
    resultSummary: row.result_summary,
    resultStatus: row.result_status,
    startedAt: row.started_at ?? row.start_date ?? null,
    endedAt: row.ended_at ?? row.end_date ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    productPassportId: row.product_passport_id ?? null,
    campaignId: row.campaign_id ?? null,
    adGroupId: row.ad_group_id ?? null,
    recommendationId: row.recommendation_id ?? null,
    expectedResult: row.expected_result ?? null,
    successMetric: row.success_metric ?? null,
    beforeMetrics: baselineMetrics,
    afterMetrics: currentMetrics,
    learningNote: row.learning_note ?? null,
    priority: row.priority ?? "MEDIUM",
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null
  };
}

function toSafeEvent(row: ExperimentEventRow): SafeExperimentEvent {
  return {
    id: row.id,
    sellerId: row.seller_id,
    experimentId: row.experiment_id,
    eventType: row.event_type,
    actor: row.actor,
    note: row.note,
    metricsSnapshot: toJsonObject(row.metrics_snapshot),
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

function nameFromInput(input: ExperimentInput): string {
  return cleanText(input.name) ?? cleanText(input.experimentName) ?? "Untitled experiment";
}

function toInsertRow(input: ExperimentInput): Record<string, unknown> {
  const name = nameFromInput(input);
  const baselineMetrics = input.baselineMetrics ?? input.beforeMetrics ?? {};
  const currentMetrics = input.currentMetrics ?? input.afterMetrics ?? {};
  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    experiment_key: cleanText(input.experimentKey),
    name,
    experiment_name: name,
    description: cleanText(input.description),
    experiment_type: input.experimentType,
    status: input.status ?? "DRAFT",
    action_id: cleanText(input.actionId),
    engine_key: cleanText(input.engineKey),
    sku: cleanText(input.sku),
    asin: cleanText(input.asin),
    hypothesis: cleanText(input.hypothesis),
    baseline_metrics: baselineMetrics,
    target_metrics: input.targetMetrics ?? {},
    current_metrics: currentMetrics,
    result_summary: cleanText(input.resultSummary),
    result_status: cleanText(input.resultStatus),
    started_at: cleanText(input.startedAt),
    ended_at: cleanText(input.endedAt),
    product_passport_id: cleanText(input.productPassportId),
    campaign_id: cleanText(input.campaignId),
    ad_group_id: cleanText(input.adGroupId),
    recommendation_id: cleanText(input.recommendationId),
    expected_result: cleanText(input.expectedResult),
    success_metric: cleanText(input.successMetric),
    before_metrics: baselineMetrics,
    after_metrics: currentMetrics,
    learning_note: cleanText(input.learningNote),
    priority: input.priority ?? "MEDIUM",
    start_date: cleanText(input.startDate),
    end_date: cleanText(input.endDate)
  };
}

function toUpdateRow(input: ExperimentUpdateInput): Record<string, unknown> {
  const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.sellerId !== undefined) updateRow.seller_id = cleanText(input.sellerId) ?? "default";
  if (input.experimentKey !== undefined) updateRow.experiment_key = cleanText(input.experimentKey);
  if (input.name !== undefined || input.experimentName !== undefined) {
    const name = nameFromInput(input as ExperimentInput);
    updateRow.name = name;
    updateRow.experiment_name = name;
  }
  if (input.description !== undefined) updateRow.description = cleanText(input.description);
  if (input.experimentType !== undefined) updateRow.experiment_type = input.experimentType;
  if (input.status !== undefined) updateRow.status = input.status;
  if (input.actionId !== undefined) updateRow.action_id = cleanText(input.actionId);
  if (input.engineKey !== undefined) updateRow.engine_key = cleanText(input.engineKey);
  if (input.sku !== undefined) updateRow.sku = cleanText(input.sku);
  if (input.asin !== undefined) updateRow.asin = cleanText(input.asin);
  if (input.hypothesis !== undefined) updateRow.hypothesis = cleanText(input.hypothesis);
  if (input.baselineMetrics !== undefined || input.beforeMetrics !== undefined) {
    const metrics = input.baselineMetrics ?? input.beforeMetrics ?? {};
    updateRow.baseline_metrics = metrics;
    updateRow.before_metrics = metrics;
  }
  if (input.targetMetrics !== undefined) updateRow.target_metrics = input.targetMetrics;
  if (input.currentMetrics !== undefined || input.afterMetrics !== undefined) {
    const metrics = input.currentMetrics ?? input.afterMetrics ?? {};
    updateRow.current_metrics = metrics;
    updateRow.after_metrics = metrics;
  }
  if (input.resultSummary !== undefined) updateRow.result_summary = cleanText(input.resultSummary);
  if (input.resultStatus !== undefined) updateRow.result_status = cleanText(input.resultStatus);
  if (input.startedAt !== undefined) updateRow.started_at = cleanText(input.startedAt);
  if (input.endedAt !== undefined) updateRow.ended_at = cleanText(input.endedAt);
  if (input.productPassportId !== undefined) updateRow.product_passport_id = cleanText(input.productPassportId);
  if (input.campaignId !== undefined) updateRow.campaign_id = cleanText(input.campaignId);
  if (input.adGroupId !== undefined) updateRow.ad_group_id = cleanText(input.adGroupId);
  if (input.recommendationId !== undefined) updateRow.recommendation_id = cleanText(input.recommendationId);
  if (input.expectedResult !== undefined) updateRow.expected_result = cleanText(input.expectedResult);
  if (input.successMetric !== undefined) updateRow.success_metric = cleanText(input.successMetric);
  if (input.learningNote !== undefined) updateRow.learning_note = cleanText(input.learningNote);
  if (input.priority !== undefined) updateRow.priority = input.priority;
  if (input.startDate !== undefined) updateRow.start_date = cleanText(input.startDate);
  if (input.endDate !== undefined) updateRow.end_date = cleanText(input.endDate);
  return updateRow;
}

export function isExperimentType(value: string): value is ExperimentType {
  return EXPERIMENT_TYPES.includes(value as ExperimentType);
}

export function isExperimentStatus(value: string): value is ExperimentStatus {
  return EXPERIMENT_STATUSES.includes(value as ExperimentStatus);
}

export function isExperimentPriority(value: string): value is ExperimentPriority {
  return EXPERIMENT_PRIORITIES.includes(value as ExperimentPriority);
}

export function isExperimentResultStatus(value: string): value is ExperimentResultStatus {
  return EXPERIMENT_RESULT_STATUSES.includes(value as ExperimentResultStatus);
}

export async function listExperiments(input: {
  sellerId: string;
  status?: ExperimentStatus;
  experimentType?: ExperimentType;
  limit?: number;
}): Promise<SafeExperimentRow[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 500);
  let query = supabase
    .from("experiments")
    .select("*")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.status) query = query.eq("status", input.status);
  if (input.experimentType) query = query.eq("experiment_type", input.experimentType);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as ExperimentRow[]).map(toSafeExperiment);
}

export async function getExperimentById(id: string, sellerId?: string): Promise<SafeExperimentRow | null> {
  let query = supabase.from("experiments").select("*").eq("id", id);
  if (sellerId) query = query.eq("seller_id", cleanText(sellerId) ?? "default");
  const { data, error } = await query.maybeSingle<ExperimentRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeExperiment(data) : null;
}

export async function listExperimentEvents(experimentId: string): Promise<SafeExperimentEvent[]> {
  const { data, error } = await supabase
    .from("experiment_events")
    .select("*")
    .eq("experiment_id", experimentId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as ExperimentEventRow[]).map(toSafeEvent);
}

async function recordExperimentEvent(input: {
  experiment: SafeExperimentRow;
  eventType: string;
  actor?: string | null;
  note?: string | null;
  metricsSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("experiment_events").insert({
    seller_id: input.experiment.sellerId,
    experiment_id: input.experiment.id,
    event_type: input.eventType,
    actor: cleanText(input.actor) ?? "system",
    note: cleanText(input.note),
    metrics_snapshot: input.metricsSnapshot ?? input.experiment.currentMetrics,
    metadata: input.metadata ?? {}
  });
  if (error) throw new Error(error.message);
}

export async function createExperiment(input: ExperimentInput): Promise<SafeExperimentRow> {
  const { data, error } = await supabase
    .from("experiments")
    .insert(toInsertRow(input))
    .select("*")
    .single<ExperimentRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not create experiment.");
  const experiment = toSafeExperiment(data);
  await recordExperimentEvent({ experiment, eventType: "CREATED", actor: "founder", metricsSnapshot: experiment.baselineMetrics }).catch(() => undefined);
  return experiment;
}

export async function updateExperiment(input: { id: string; updates: ExperimentUpdateInput }): Promise<SafeExperimentRow | null> {
  const { data, error } = await supabase
    .from("experiments")
    .update(toUpdateRow(input.updates))
    .eq("id", input.id)
    .select("*")
    .maybeSingle<ExperimentRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeExperiment(data) : null;
}

function experimentTypeForAction(action: SafeActionLedgerRow): ExperimentType {
  if (action.actionType.includes("PPC") || action.actionType.includes("KEYWORD") || action.actionType.includes("TARGET")) return "PPC_KEYWORD_TEST";
  if (action.actionType.includes("IMAGE")) return "LISTING_IMAGE_TEST";
  if (action.actionType.includes("A_PLUS")) return "CONTENT_A_PLUS_TEST";
  if (action.actionType.includes("LISTING_TITLE")) return "LISTING_TITLE_TEST";
  if (action.actionType.includes("PRICING")) return "PRICING_TEST";
  return "OTHER";
}

export async function createExperimentFromAction(actionId: string): Promise<SafeExperimentRow> {
  const action = await getActionLedgerById(actionId);
  if (!action) throw new Error("ACTION_NOT_FOUND");
  if (action.approvalStatus !== "APPROVED" && action.state !== "APPROVED" && action.state !== "MONITORING") {
    throw new Error("ACTION_NOT_APPROVED");
  }

  return createExperiment({
    sellerId: action.sellerId,
    experimentKey: `action:${action.id}`,
    name: `Measure outcome: ${action.title}`,
    description: action.summary,
    experimentType: experimentTypeForAction(action),
    status: "DRAFT",
    actionId: action.id,
    engineKey: cleanText(action.source) ?? null,
    sku: action.sku,
    asin: action.asin,
    hypothesis: action.recommendedAction ?? action.summary,
    baselineMetrics: toJsonObject(action.evidence),
    targetMetrics: {
      expectedProfitImpact: action.expectedProfitImpact,
      expectedSalesImpact: action.expectedSalesImpact,
      expectedBrandImpact: action.expectedBrandImpact
    }
  });
}

export async function startExperiment(id: string, actor = "founder"): Promise<SafeExperimentRow | null> {
  const existing = await getExperimentById(id);
  if (!existing) return null;
  const row = await updateExperiment({
    id,
    updates: {
      status: "RUNNING",
      startedAt: existing.startedAt ?? new Date().toISOString(),
      startDate: existing.startDate ?? today(),
      baselineMetrics: existing.baselineMetrics
    }
  });
  if (row) await recordExperimentEvent({ experiment: row, eventType: "STARTED", actor, metricsSnapshot: row.baselineMetrics }).catch(() => undefined);
  return row;
}

export async function recordExperimentCheckpoint(input: {
  id: string;
  actor?: string | null;
  note?: string | null;
  currentMetrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<SafeExperimentRow | null> {
  const existing = await getExperimentById(input.id);
  if (!existing) return null;
  const metrics = input.currentMetrics ?? existing.currentMetrics;
  const row = await updateExperiment({ id: input.id, updates: { currentMetrics: metrics } });
  if (row) await recordExperimentEvent({ experiment: row, eventType: "CHECKPOINT_RECORDED", actor: input.actor, note: input.note, metricsSnapshot: metrics, metadata: input.metadata }).catch(() => undefined);
  return row;
}

export async function completeExperiment(input: {
  id: string;
  resultStatus: ExperimentResultStatus;
  resultSummary?: string | null;
  learningNote?: string | null;
  currentMetrics?: Record<string, unknown>;
  actor?: string | null;
}): Promise<SafeExperimentRow | null> {
  const existing = await getExperimentById(input.id);
  if (!existing) return null;
  const metrics = input.currentMetrics ?? existing.currentMetrics;
  const row = await updateExperiment({
    id: input.id,
    updates: {
      status: "COMPLETED",
      resultStatus: input.resultStatus,
      resultSummary: input.resultSummary,
      learningNote: input.learningNote,
      currentMetrics: metrics,
      endedAt: existing.endedAt ?? new Date().toISOString(),
      endDate: existing.endDate ?? today()
    }
  });

  if (row) {
    await recordExperimentEvent({
      experiment: row,
      eventType: "COMPLETED",
      actor: input.actor,
      note: input.resultSummary,
      metricsSnapshot: metrics,
      metadata: { resultStatus: input.resultStatus }
    }).catch(() => undefined);

    await recordLearningEventSafe({
      sellerId: row.sellerId,
      actionId: row.actionId,
      engineKey: row.engineKey,
      source: "EXPERIMENT_TRACKING",
      sourceId: row.id,
      actionType: row.experimentType,
      entityType: row.asin ? "ASIN" : row.sku ? "SKU" : "ACCOUNT",
      entityId: row.asin ?? row.sku ?? row.id,
      sku: row.sku,
      asin: row.asin,
      eventType: row.actionId ? "ACTION_COMPLETED" : "MANUAL_OUTCOME_NOTE",
      outcomeStatus: input.resultStatus,
      actor: cleanText(input.actor) ?? "founder",
      note: input.learningNote ?? input.resultSummary,
      beforeMetrics: row.baselineMetrics,
      afterMetrics: metrics,
      evidence: { experimentId: row.id, resultStatus: input.resultStatus },
      metadata: { experimentTracking: true }
    });
  }

  return row;
}

export async function cancelExperiment(input: { id: string; learningNote?: string | null; actor?: string | null }): Promise<SafeExperimentRow | null> {
  const row = await updateExperiment({ id: input.id, updates: { status: "CANCELLED", learningNote: input.learningNote } });
  if (row) await recordExperimentEvent({ experiment: row, eventType: "CANCELLED", actor: input.actor, note: input.learningNote }).catch(() => undefined);
  return row;
}

async function countExperiments(input: { sellerId: string; statuses?: string[] }): Promise<number> {
  let query = supabase.from("experiments").select("id", { count: "exact", head: true }).eq("seller_id", input.sellerId);
  if (input.statuses?.length === 1) query = query.eq("status", input.statuses[0]);
  if (input.statuses && input.statuses.length > 1) query = query.in("status", input.statuses);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function getExperimentSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalExperiments: number;
  draftExperiments: number;
  runningExperiments: number;
  completedExperiments: number;
  cancelledExperiments: number;
  latestExperiments: SafeExperimentRow[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [totalExperiments, draftExperiments, runningExperiments, completedExperiments, cancelledExperiments, latestExperiments] = await Promise.all([
    countExperiments({ sellerId }),
    countExperiments({ sellerId, statuses: ["DRAFT", "PLANNED"] }),
    countExperiments({ sellerId, statuses: ["RUNNING", "ACTIVE"] }),
    countExperiments({ sellerId, statuses: ["COMPLETED"] }),
    countExperiments({ sellerId, statuses: ["CANCELLED"] }),
    listExperiments({ sellerId, limit: 10 })
  ]);

  return { ok: true, sellerId, totalExperiments, draftExperiments, runningExperiments, completedExperiments, cancelledExperiments, latestExperiments };
}
