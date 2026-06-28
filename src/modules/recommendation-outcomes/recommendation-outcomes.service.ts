import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getAiRecommendationById } from "../recommendations/recommendations.service";
import {
  RecommendationOutcomeEvaluateInput,
  RecommendationOutcomeInput,
  RecommendationOutcomeRow,
  RecommendationOutcomeStatus,
  RecommendationOutcomeUpdateInput,
  SafeRecommendationOutcomeRow
} from "./recommendation-outcomes.types";

export const RECOMMENDATION_OUTCOME_STATUSES: RecommendationOutcomeStatus[] = [
  "WORKED",
  "FAILED",
  "NEEDS_MORE_DATA",
  "PARTIAL",
  "NOT_APPLICABLE"
];

const EVALUATED_OUTCOME_STATUSES: RecommendationOutcomeStatus[] = [
  "WORKED",
  "FAILED",
  "PARTIAL",
  "NOT_APPLICABLE"
];

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeErrorMessage(message: string): string {
  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.AMAZON_LWA_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_SECRET,
    env.ENCRYPTION_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (safeMessage, secretValue) => safeMessage.replaceAll(secretValue, "[REDACTED]"),
    message
  );
}

function logOutcomeError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIntegerOrNull(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function toJsonObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function metricNumber(metrics: Record<string, unknown>, key: string): number | null {
  return toNumberOrNull(metrics[key]);
}

function metricInteger(metrics: Record<string, unknown>, key: string): number | null {
  return toIntegerOrNull(metrics[key]);
}

function subtractIfPossible(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : after - before;
}

function toSafeOutcome(row: RecommendationOutcomeRow): SafeRecommendationOutcomeRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    recommendationId: row.recommendation_id,
    experimentId: row.experiment_id,
    outcomeStatus: RECOMMENDATION_OUTCOME_STATUSES.includes(row.outcome_status)
      ? row.outcome_status
      : "NEEDS_MORE_DATA",
    evaluationWindowDays: row.evaluation_window_days,
    beforeMetrics: row.before_metrics ?? {},
    afterMetrics: row.after_metrics ?? {},
    profitImpact: toNumberOrNull(row.profit_impact),
    salesImpact: toNumberOrNull(row.sales_impact),
    costImpact: toNumberOrNull(row.cost_impact),
    acosBefore: toNumberOrNull(row.acos_before),
    acosAfter: toNumberOrNull(row.acos_after),
    ordersBefore: toIntegerOrNull(row.orders_before),
    ordersAfter: toIntegerOrNull(row.orders_after),
    confidenceAfter: toNumberOrNull(row.confidence_after),
    resultSummary: row.result_summary,
    learningNote: row.learning_note,
    evaluatedAt: row.evaluated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toInsertRow(recommendationId: string, input: RecommendationOutcomeInput): Record<string, unknown> {
  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    recommendation_id: recommendationId,
    experiment_id: cleanText(input.experimentId),
    outcome_status: input.outcomeStatus ?? "NEEDS_MORE_DATA",
    evaluation_window_days: input.evaluationWindowDays ?? 7,
    before_metrics: toJsonObject(input.beforeMetrics),
    after_metrics: toJsonObject(input.afterMetrics),
    profit_impact: input.profitImpact ?? null,
    sales_impact: input.salesImpact ?? null,
    cost_impact: input.costImpact ?? null,
    acos_before: input.acosBefore ?? null,
    acos_after: input.acosAfter ?? null,
    orders_before: input.ordersBefore ?? null,
    orders_after: input.ordersAfter ?? null,
    confidence_after: input.confidenceAfter ?? null,
    result_summary: cleanText(input.resultSummary),
    learning_note: cleanText(input.learningNote)
  };
}

function toUpdateRow(input: RecommendationOutcomeUpdateInput, existing: SafeRecommendationOutcomeRow): Record<string, unknown> {
  const updateRow: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (input.sellerId !== undefined) updateRow.seller_id = cleanText(input.sellerId) ?? "default";
  if (input.experimentId !== undefined) updateRow.experiment_id = cleanText(input.experimentId);
  if (input.outcomeStatus !== undefined) updateRow.outcome_status = input.outcomeStatus;
  if (input.evaluationWindowDays !== undefined) updateRow.evaluation_window_days = input.evaluationWindowDays;
  if (input.beforeMetrics !== undefined) updateRow.before_metrics = toJsonObject(input.beforeMetrics);
  if (input.afterMetrics !== undefined) updateRow.after_metrics = toJsonObject(input.afterMetrics);
  if (input.profitImpact !== undefined) updateRow.profit_impact = input.profitImpact;
  if (input.salesImpact !== undefined) updateRow.sales_impact = input.salesImpact;
  if (input.costImpact !== undefined) updateRow.cost_impact = input.costImpact;
  if (input.acosBefore !== undefined) updateRow.acos_before = input.acosBefore;
  if (input.acosAfter !== undefined) updateRow.acos_after = input.acosAfter;
  if (input.ordersBefore !== undefined) updateRow.orders_before = input.ordersBefore;
  if (input.ordersAfter !== undefined) updateRow.orders_after = input.ordersAfter;
  if (input.confidenceAfter !== undefined) updateRow.confidence_after = input.confidenceAfter;
  if (input.resultSummary !== undefined) updateRow.result_summary = cleanText(input.resultSummary);
  if (input.learningNote !== undefined) updateRow.learning_note = cleanText(input.learningNote);

  if (
    input.outcomeStatus &&
    EVALUATED_OUTCOME_STATUSES.includes(input.outcomeStatus) &&
    !existing.evaluatedAt
  ) {
    updateRow.evaluated_at = new Date().toISOString();
  }

  return updateRow;
}

export function isRecommendationOutcomeStatus(value: string): value is RecommendationOutcomeStatus {
  return RECOMMENDATION_OUTCOME_STATUSES.includes(value as RecommendationOutcomeStatus);
}

export async function listRecommendationOutcomes(input: {
  sellerId: string;
  status?: RecommendationOutcomeStatus;
  recommendationId?: string;
  experimentId?: string;
}): Promise<SafeRecommendationOutcomeRow[]> {
  let query = supabase
    .from("recommendation_outcomes")
    .select("*")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(200);

  if (input.status) query = query.eq("outcome_status", input.status);
  if (input.recommendationId) query = query.eq("recommendation_id", input.recommendationId);
  if (input.experimentId) query = query.eq("experiment_id", input.experimentId);

  const { data, error } = await query;

  if (error) {
    logOutcomeError("Could not list recommendation outcomes.", error);
    throw new Error("Could not load recommendation outcomes from Supabase.");
  }

  return ((data ?? []) as RecommendationOutcomeRow[]).map(toSafeOutcome);
}

export async function listRecommendationOutcomesByRecommendationId(
  recommendationId: string
): Promise<SafeRecommendationOutcomeRow[]> {
  const { data, error } = await supabase
    .from("recommendation_outcomes")
    .select("*")
    .eq("recommendation_id", recommendationId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    logOutcomeError("Could not list outcomes for recommendation.", error);
    throw new Error("Could not load recommendation outcomes from Supabase.");
  }

  return ((data ?? []) as RecommendationOutcomeRow[]).map(toSafeOutcome);
}

export async function getRecommendationOutcomeById(id: string): Promise<SafeRecommendationOutcomeRow | null> {
  const { data, error } = await supabase
    .from("recommendation_outcomes")
    .select("*")
    .eq("id", id)
    .maybeSingle<RecommendationOutcomeRow>();

  if (error) {
    logOutcomeError("Could not load recommendation outcome.", error);
    throw new Error("Could not load recommendation outcome from Supabase.");
  }

  return data ? toSafeOutcome(data) : null;
}

export async function createRecommendationOutcomeForRecommendation(input: {
  recommendationId: string;
  outcome: RecommendationOutcomeInput;
}): Promise<SafeRecommendationOutcomeRow | null> {
  const recommendation = await getAiRecommendationById(input.recommendationId);

  if (!recommendation) {
    return null;
  }

  const { data, error } = await supabase
    .from("recommendation_outcomes")
    .insert(toInsertRow(input.recommendationId, input.outcome))
    .select("*")
    .single<RecommendationOutcomeRow>();

  if (error || !data) {
    if (error) {
      logOutcomeError("Could not create recommendation outcome.", error);
    }
    throw new Error("Could not create recommendation outcome in Supabase.");
  }

  return toSafeOutcome(data);
}

export async function updateRecommendationOutcome(input: {
  id: string;
  updates: RecommendationOutcomeUpdateInput;
}): Promise<SafeRecommendationOutcomeRow | null> {
  const existing = await getRecommendationOutcomeById(input.id);

  if (!existing) {
    return null;
  }

  const { data, error } = await supabase
    .from("recommendation_outcomes")
    .update(toUpdateRow(input.updates, existing))
    .eq("id", input.id)
    .select("*")
    .single<RecommendationOutcomeRow>();

  if (error || !data) {
    if (error) {
      logOutcomeError("Could not update recommendation outcome.", error);
    }
    throw new Error("Could not update recommendation outcome in Supabase.");
  }

  return toSafeOutcome(data);
}

export async function evaluateRecommendationOutcome(input: {
  id: string;
  evaluation: RecommendationOutcomeEvaluateInput;
}): Promise<SafeRecommendationOutcomeRow | null> {
  const existing = await getRecommendationOutcomeById(input.id);

  if (!existing) {
    return null;
  }

  const afterMetrics = toJsonObject(input.evaluation.afterMetrics);
  const beforeMetrics = existing.beforeMetrics;
  const salesAfter = metricNumber(afterMetrics, "sales");
  const salesBefore = metricNumber(beforeMetrics, "sales");
  const costAfter = metricNumber(afterMetrics, "cost");
  const costBefore = metricNumber(beforeMetrics, "cost");

  return updateRecommendationOutcome({
    id: input.id,
    updates: {
      outcomeStatus: input.evaluation.outcomeStatus,
      afterMetrics,
      salesImpact: subtractIfPossible(salesAfter, salesBefore),
      costImpact: subtractIfPossible(costAfter, costBefore),
      ordersAfter: metricInteger(afterMetrics, "orders"),
      acosAfter: metricNumber(afterMetrics, "acos"),
      resultSummary: input.evaluation.resultSummary,
      learningNote: input.evaluation.learningNote
    }
  });
}
