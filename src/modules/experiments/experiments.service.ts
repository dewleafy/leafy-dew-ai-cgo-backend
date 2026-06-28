import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ExperimentInput,
  ExperimentPriority,
  ExperimentRow,
  ExperimentStatus,
  ExperimentType,
  ExperimentUpdateInput,
  SafeExperimentRow
} from "./experiments.types";

export const EXPERIMENT_TYPES: ExperimentType[] = [
  "PPC_KEYWORD_TEST",
  "PPC_PRODUCT_TARGET_TEST",
  "LISTING_CONTENT_TEST",
  "IMAGE_TEST",
  "PRICE_TEST",
  "BUNDLE_TEST",
  "BRAND_CONTENT_TEST",
  "OTHER"
];

export const EXPERIMENT_STATUSES: ExperimentStatus[] = [
  "PLANNED",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
];

export const EXPERIMENT_PRIORITIES: ExperimentPriority[] = ["LOW", "MEDIUM", "HIGH"];

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

function logExperimentError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function toJsonObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toSafeExperiment(row: ExperimentRow): SafeExperimentRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    experimentName: row.experiment_name,
    experimentType: row.experiment_type,
    productPassportId: row.product_passport_id,
    sku: row.sku,
    asin: row.asin,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    recommendationId: row.recommendation_id,
    hypothesis: row.hypothesis,
    expectedResult: row.expected_result,
    successMetric: row.success_metric,
    beforeMetrics: row.before_metrics ?? {},
    afterMetrics: row.after_metrics ?? {},
    resultSummary: row.result_summary,
    learningNote: row.learning_note,
    status: row.status,
    priority: row.priority,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toInsertRow(input: ExperimentInput) {
  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    experiment_name: input.experimentName.trim(),
    experiment_type: input.experimentType,
    product_passport_id: cleanText(input.productPassportId),
    sku: cleanText(input.sku),
    asin: cleanText(input.asin),
    campaign_id: cleanText(input.campaignId),
    ad_group_id: cleanText(input.adGroupId),
    recommendation_id: cleanText(input.recommendationId),
    hypothesis: cleanText(input.hypothesis),
    expected_result: cleanText(input.expectedResult),
    success_metric: cleanText(input.successMetric),
    before_metrics: toJsonObject(input.beforeMetrics),
    after_metrics: toJsonObject(input.afterMetrics),
    result_summary: cleanText(input.resultSummary),
    learning_note: cleanText(input.learningNote),
    status: input.status ?? "PLANNED",
    priority: input.priority ?? "MEDIUM",
    start_date: cleanText(input.startDate),
    end_date: cleanText(input.endDate)
  };
}

function toUpdateRow(input: ExperimentUpdateInput): Record<string, unknown> {
  const updateRow: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (input.sellerId !== undefined) updateRow.seller_id = cleanText(input.sellerId) ?? "default";
  if (input.experimentName !== undefined) updateRow.experiment_name = input.experimentName.trim();
  if (input.experimentType !== undefined) updateRow.experiment_type = input.experimentType;
  if (input.productPassportId !== undefined) updateRow.product_passport_id = cleanText(input.productPassportId);
  if (input.sku !== undefined) updateRow.sku = cleanText(input.sku);
  if (input.asin !== undefined) updateRow.asin = cleanText(input.asin);
  if (input.campaignId !== undefined) updateRow.campaign_id = cleanText(input.campaignId);
  if (input.adGroupId !== undefined) updateRow.ad_group_id = cleanText(input.adGroupId);
  if (input.recommendationId !== undefined) updateRow.recommendation_id = cleanText(input.recommendationId);
  if (input.hypothesis !== undefined) updateRow.hypothesis = cleanText(input.hypothesis);
  if (input.expectedResult !== undefined) updateRow.expected_result = cleanText(input.expectedResult);
  if (input.successMetric !== undefined) updateRow.success_metric = cleanText(input.successMetric);
  if (input.beforeMetrics !== undefined) updateRow.before_metrics = toJsonObject(input.beforeMetrics);
  if (input.afterMetrics !== undefined) updateRow.after_metrics = toJsonObject(input.afterMetrics);
  if (input.resultSummary !== undefined) updateRow.result_summary = cleanText(input.resultSummary);
  if (input.learningNote !== undefined) updateRow.learning_note = cleanText(input.learningNote);
  if (input.status !== undefined) updateRow.status = input.status;
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

export async function listExperiments(input: {
  sellerId: string;
  status?: ExperimentStatus;
  experimentType?: ExperimentType;
}): Promise<SafeExperimentRow[]> {
  let query = supabase
    .from("experiments")
    .select("*")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(200);

  if (input.status) {
    query = query.eq("status", input.status);
  }

  if (input.experimentType) {
    query = query.eq("experiment_type", input.experimentType);
  }

  const { data, error } = await query;

  if (error) {
    logExperimentError("Could not list experiments.", error);
    throw new Error("Could not load experiments from Supabase.");
  }

  return ((data ?? []) as ExperimentRow[]).map(toSafeExperiment);
}

export async function getExperimentById(id: string): Promise<SafeExperimentRow | null> {
  const { data, error } = await supabase
    .from("experiments")
    .select("*")
    .eq("id", id)
    .maybeSingle<ExperimentRow>();

  if (error) {
    logExperimentError("Could not load experiment.", error);
    throw new Error("Could not load experiment from Supabase.");
  }

  return data ? toSafeExperiment(data) : null;
}

export async function createExperiment(input: ExperimentInput): Promise<SafeExperimentRow> {
  const { data, error } = await supabase
    .from("experiments")
    .insert(toInsertRow(input))
    .select("*")
    .single<ExperimentRow>();

  if (error || !data) {
    if (error) {
      logExperimentError("Could not create experiment.", error);
    }
    throw new Error("Could not create experiment in Supabase.");
  }

  return toSafeExperiment(data);
}

export async function updateExperiment(input: {
  id: string;
  updates: ExperimentUpdateInput;
}): Promise<SafeExperimentRow | null> {
  const existing = await getExperimentById(input.id);

  if (!existing) {
    return null;
  }

  const { data, error } = await supabase
    .from("experiments")
    .update(toUpdateRow(input.updates))
    .eq("id", input.id)
    .select("*")
    .single<ExperimentRow>();

  if (error || !data) {
    if (error) {
      logExperimentError("Could not update experiment.", error);
    }
    throw new Error("Could not update experiment in Supabase.");
  }

  return toSafeExperiment(data);
}

export async function startExperiment(id: string): Promise<SafeExperimentRow | null> {
  const existing = await getExperimentById(id);

  if (!existing) {
    return null;
  }

  return updateExperiment({
    id,
    updates: {
      status: "ACTIVE",
      startDate: existing.startDate ?? today()
    }
  });
}

export async function completeExperiment(input: {
  id: string;
  resultSummary?: string | null;
  learningNote?: string | null;
  afterMetrics?: Record<string, unknown>;
}): Promise<SafeExperimentRow | null> {
  const existing = await getExperimentById(input.id);

  if (!existing) {
    return null;
  }

  return updateExperiment({
    id: input.id,
    updates: {
      status: "COMPLETED",
      endDate: existing.endDate ?? today(),
      resultSummary: input.resultSummary,
      learningNote: input.learningNote,
      afterMetrics: input.afterMetrics
    }
  });
}

export async function cancelExperiment(input: {
  id: string;
  learningNote?: string | null;
}): Promise<SafeExperimentRow | null> {
  return updateExperiment({
    id: input.id,
    updates: {
      status: "CANCELLED",
      learningNote: input.learningNote
    }
  });
}
