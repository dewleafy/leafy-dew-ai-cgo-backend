import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ActionLearningEventRow,
  EngineLearningSummaryRow,
  LearningEventInput,
  LearningEventType,
  SafeActionLearningEvent,
  SafeEngineLearningSummary
} from "./learning-loop.types";

const SCORE_DELTAS: Partial<Record<LearningEventType, { usefulness: number; confidence: number }>> = {
  ACTION_APPROVED: { usefulness: 2, confidence: 1 },
  ACTION_REJECTED: { usefulness: -2, confidence: -1 },
  ACTION_COMPLETED: { usefulness: 3, confidence: 2 },
  ACTION_MONITORING: { usefulness: 1, confidence: 0 },
  ACTION_REOPENED: { usefulness: 0, confidence: -1 },
  DUPLICATE_ACTION_SKIPPED: { usefulness: 0.5, confidence: 0 },
  ENGINE_FAILED: { usefulness: -3, confidence: -2 }
};

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampScore(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNullableJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toSafeEvent(row: ActionLearningEventRow): SafeActionLearningEvent {
  return {
    id: row.id,
    sellerId: row.seller_id,
    actionId: row.action_id,
    engineKey: row.engine_key,
    source: row.source,
    sourceId: row.source_id,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    eventType: row.event_type,
    outcomeStatus: row.outcome_status,
    actor: row.actor,
    note: row.note,
    beforeMetrics: toNullableJsonObject(row.before_metrics),
    afterMetrics: toNullableJsonObject(row.after_metrics),
    observedProfitImpact: toNumberOrNull(row.observed_profit_impact),
    observedSalesImpact: toNumberOrNull(row.observed_sales_impact),
    observedBrandImpact: toNumberOrNull(row.observed_brand_impact),
    confidenceBefore: row.confidence_before,
    confidenceAfter: row.confidence_after,
    evidence: toJsonObject(row.evidence),
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

function toSafeSummary(row: EngineLearningSummaryRow): SafeEngineLearningSummary {
  return {
    id: row.id,
    sellerId: row.seller_id,
    engineKey: row.engine_key,
    totalActionsCreated: toNumber(row.total_actions_created),
    approvedCount: toNumber(row.approved_count),
    rejectedCount: toNumber(row.rejected_count),
    monitoringCount: toNumber(row.monitoring_count),
    completedCount: toNumber(row.completed_count),
    reopenedCount: toNumber(row.reopened_count),
    duplicateSkippedCount: toNumber(row.duplicate_skipped_count),
    noActionCount: toNumber(row.no_action_count),
    failedCount: toNumber(row.failed_count),
    usefulnessScore: toNumber(row.usefulness_score),
    confidenceScore: toNumber(row.confidence_score),
    lastLearningEventAt: row.last_learning_event_at,
    lastSummary: row.last_summary,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function countFieldForEvent(eventType: string): string | null {
  if (eventType === "ACTION_CREATED" || eventType === "ENGINE_PREVIEW_ACTION_CREATED" || eventType === "LISTING_DRAFT_CREATED" || eventType === "IMAGE_A_PLUS_RECOMMENDATION_CREATED") {
    return "total_actions_created";
  }
  if (eventType === "ACTION_APPROVED") return "approved_count";
  if (eventType === "ACTION_REJECTED") return "rejected_count";
  if (eventType === "ACTION_MONITORING") return "monitoring_count";
  if (eventType === "ACTION_COMPLETED" || eventType === "COST_DATA_AUTO_RESOLVED" || eventType === "SHADOW_EXECUTION_COMPLETED") return "completed_count";
  if (eventType === "ACTION_REOPENED") return "reopened_count";
  if (eventType === "DUPLICATE_ACTION_SKIPPED") return "duplicate_skipped_count";
  if (eventType === "ENGINE_PREVIEW_NO_ACTION" || eventType === "ENGINE_SKIPPED_NO_DATA" || eventType === "ENGINE_SKIPPED_TEMPLATE_NOT_IMPLEMENTED") return "no_action_count";
  if (eventType === "ENGINE_FAILED" || eventType === "SHADOW_EXECUTION_FAILED") return "failed_count";
  return null;
}

async function upsertSummaryForEvent(input: LearningEventInput, event: SafeActionLearningEvent): Promise<void> {
  const engineKey = cleanText(input.engineKey);
  if (!engineKey) return;

  const sellerId = cleanText(input.sellerId) ?? "default";
  const { data: existing, error: loadError } = await supabase
    .from("engine_learning_summary")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("engine_key", engineKey)
    .maybeSingle<EngineLearningSummaryRow>();

  if (loadError) {
    throw new Error(loadError.message);
  }

  const delta = SCORE_DELTAS[input.eventType] ?? { usefulness: 0, confidence: 0 };
  const field = countFieldForEvent(input.eventType);
  const updateRow: Record<string, unknown> = {
    seller_id: sellerId,
    engine_key: engineKey,
    usefulness_score: clampScore((existing ? toNumber(existing.usefulness_score) : 50) + delta.usefulness),
    confidence_score: clampScore((existing ? toNumber(existing.confidence_score) : 50) + delta.confidence),
    last_learning_event_at: event.createdAt ?? new Date().toISOString(),
    last_summary: event.note ?? `Last event: ${input.eventType}`,
    metadata: {
      ...(existing ? toJsonObject(existing.metadata) : {}),
      lastEventType: input.eventType,
      lastActionId: event.actionId,
      lastSource: event.source
    },
    updated_at: new Date().toISOString()
  };

  if (field) {
    updateRow[field] = (existing ? toNumber((existing as unknown as Record<string, unknown>)[field]) : 0) + 1;
  }

  if (existing) {
    const { error } = await supabase
      .from("engine_learning_summary")
      .update(updateRow)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase
    .from("engine_learning_summary")
    .insert(updateRow);
  if (error) throw new Error(error.message);
}

export async function recordLearningEvent(input: LearningEventInput): Promise<SafeActionLearningEvent> {
  const { data, error } = await supabase
    .from("action_learning_events")
    .insert({
      seller_id: cleanText(input.sellerId) ?? "default",
      action_id: cleanText(input.actionId),
      engine_key: cleanText(input.engineKey),
      source: cleanText(input.source),
      source_id: cleanText(input.sourceId),
      action_type: cleanText(input.actionType),
      entity_type: cleanText(input.entityType),
      entity_id: cleanText(input.entityId),
      sku: cleanText(input.sku),
      asin: cleanText(input.asin),
      event_type: input.eventType,
      outcome_status: cleanText(input.outcomeStatus) ?? "RECORDED",
      actor: cleanText(input.actor) ?? "system",
      note: cleanText(input.note),
      before_metrics: input.beforeMetrics ?? null,
      after_metrics: input.afterMetrics ?? null,
      observed_profit_impact: input.observedProfitImpact ?? null,
      observed_sales_impact: input.observedSalesImpact ?? null,
      observed_brand_impact: input.observedBrandImpact ?? null,
      confidence_before: cleanText(input.confidenceBefore),
      confidence_after: cleanText(input.confidenceAfter),
      evidence: input.evidence ?? {},
      metadata: input.metadata ?? {}
    })
    .select("*")
    .single<ActionLearningEventRow>();

  if (error || !data) {
    throw new Error(error?.message ?? "Could not record learning event.");
  }

  const event = toSafeEvent(data);
  await upsertSummaryForEvent(input, event);
  return event;
}

export async function recordLearningEventSafe(input: LearningEventInput): Promise<SafeActionLearningEvent | null> {
  try {
    return await recordLearningEvent(input);
  } catch (error) {
    logger.warn("Learning Loop insert failed safely.", {
      sellerId: cleanText(input.sellerId) ?? "default",
      eventType: input.eventType,
      actionId: cleanText(input.actionId),
      engineKey: cleanText(input.engineKey),
      message: error instanceof Error ? error.message : "Unknown learning error"
    });
    return null;
  }
}

export async function listLearningEvents(input: {
  sellerId: string;
  limit: number;
  engineKey?: string;
}): Promise<SafeActionLearningEvent[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  let query = supabase
    .from("action_learning_events")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.engineKey) query = query.eq("engine_key", input.engineKey);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as ActionLearningEventRow[]).map(toSafeEvent);
}

export async function listEngineLearningSummaries(sellerIdInput: string): Promise<SafeEngineLearningSummary[]> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("engine_learning_summary")
    .select("*")
    .eq("seller_id", sellerId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message);
  return ((data ?? []) as EngineLearningSummaryRow[]).map(toSafeSummary);
}

export async function getEngineLearning(input: {
  sellerId: string;
  engineKey: string;
}): Promise<{ summary: SafeEngineLearningSummary | null; events: SafeActionLearningEvent[] }> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const engineKey = cleanText(input.engineKey) ?? "";
  const [summaryResult, events] = await Promise.all([
    supabase
      .from("engine_learning_summary")
      .select("*")
      .eq("seller_id", sellerId)
      .eq("engine_key", engineKey)
      .maybeSingle<EngineLearningSummaryRow>(),
    listLearningEvents({ sellerId, engineKey, limit: 100 })
  ]);

  if (summaryResult.error) throw new Error(summaryResult.error.message);

  return {
    summary: summaryResult.data ? toSafeSummary(summaryResult.data) : null,
    events
  };
}

type SummaryAccumulator = Omit<SafeEngineLearningSummary, "id" | "sellerId" | "createdAt" | "updatedAt" | "metadata"> & {
  usefulnessScore: number;
  confidenceScore: number;
  metadata: Record<string, unknown>;
};

function emptyAccumulator(engineKey: string): SummaryAccumulator {
  return {
    engineKey,
    totalActionsCreated: 0,
    approvedCount: 0,
    rejectedCount: 0,
    monitoringCount: 0,
    completedCount: 0,
    reopenedCount: 0,
    duplicateSkippedCount: 0,
    noActionCount: 0,
    failedCount: 0,
    usefulnessScore: 50,
    confidenceScore: 50,
    lastLearningEventAt: null,
    lastSummary: null,
    metadata: {}
  };
}

export async function rebuildLearningSummaries(sellerIdInput: string): Promise<{
  sellerId: string;
  eventsScanned: number;
  summariesUpserted: number;
  rows: SafeEngineLearningSummary[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("action_learning_events")
    .select("*")
    .eq("seller_id", sellerId)
    .not("engine_key", "is", null)
    .order("created_at", { ascending: true })
    .limit(5000);

  if (error) throw new Error(error.message);

  const events = ((data ?? []) as ActionLearningEventRow[]).map(toSafeEvent);
  const byEngine = new Map<string, SummaryAccumulator>();

  for (const event of events) {
    if (!event.engineKey) continue;
    const summary = byEngine.get(event.engineKey) ?? emptyAccumulator(event.engineKey);
    const field = countFieldForEvent(event.eventType);
    if (field === "total_actions_created") summary.totalActionsCreated += 1;
    if (field === "approved_count") summary.approvedCount += 1;
    if (field === "rejected_count") summary.rejectedCount += 1;
    if (field === "monitoring_count") summary.monitoringCount += 1;
    if (field === "completed_count") summary.completedCount += 1;
    if (field === "reopened_count") summary.reopenedCount += 1;
    if (field === "duplicate_skipped_count") summary.duplicateSkippedCount += 1;
    if (field === "no_action_count") summary.noActionCount += 1;
    if (field === "failed_count") summary.failedCount += 1;

    const delta = SCORE_DELTAS[event.eventType as LearningEventType] ?? { usefulness: 0, confidence: 0 };
    summary.usefulnessScore = clampScore(summary.usefulnessScore + delta.usefulness);
    summary.confidenceScore = clampScore(summary.confidenceScore + delta.confidence);
    summary.lastLearningEventAt = event.createdAt;
    summary.lastSummary = event.note ?? `Last event: ${event.eventType}`;
    summary.metadata = {
      lastEventType: event.eventType,
      lastActionId: event.actionId,
      rebuiltAt: new Date().toISOString()
    };
    byEngine.set(event.engineKey, summary);
  }

  const upsertRows = Array.from(byEngine.values()).map((summary) => ({
    seller_id: sellerId,
    engine_key: summary.engineKey,
    total_actions_created: summary.totalActionsCreated,
    approved_count: summary.approvedCount,
    rejected_count: summary.rejectedCount,
    monitoring_count: summary.monitoringCount,
    completed_count: summary.completedCount,
    reopened_count: summary.reopenedCount,
    duplicate_skipped_count: summary.duplicateSkippedCount,
    no_action_count: summary.noActionCount,
    failed_count: summary.failedCount,
    usefulness_score: summary.usefulnessScore,
    confidence_score: summary.confidenceScore,
    last_learning_event_at: summary.lastLearningEventAt,
    last_summary: summary.lastSummary,
    metadata: summary.metadata,
    updated_at: new Date().toISOString()
  }));

  if (upsertRows.length) {
    const { error: upsertError } = await supabase
      .from("engine_learning_summary")
      .upsert(upsertRows, { onConflict: "seller_id,engine_key" });
    if (upsertError) throw new Error(upsertError.message);
  }

  const rows = await listEngineLearningSummaries(sellerId);
  return {
    sellerId,
    eventsScanned: events.length,
    summariesUpserted: upsertRows.length,
    rows
  };
}
