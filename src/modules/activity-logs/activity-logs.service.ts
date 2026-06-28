import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ActivityLogInput,
  ActivityLogRow,
  ActivityLogStatus,
  SafeActivityLogRow
} from "./activity-logs.types";

export const ACTIVITY_LOG_STATUSES: ActivityLogStatus[] = [
  "INFO",
  "SUCCESS",
  "WARNING",
  "ERROR"
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

function logActivityError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function toJsonObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toSafeActivityLog(row: ActivityLogRow): SafeActivityLogRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    action: row.action,
    status: ACTIVITY_LOG_STATUSES.includes(row.status) ? row.status : "INFO",
    message: row.message,
    metadata: row.metadata ?? {},
    userNote: row.user_note,
    createdAt: row.created_at
  };
}

function toInsertRow(input: ActivityLogInput): Record<string, unknown> {
  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    event_type: input.eventType.trim(),
    entity_type: cleanText(input.entityType),
    entity_id: cleanText(input.entityId),
    entity_label: cleanText(input.entityLabel),
    action: input.action.trim(),
    status: input.status ?? "INFO",
    message: cleanText(input.message),
    metadata: toJsonObject(input.metadata),
    user_note: cleanText(input.userNote)
  };
}

export function isActivityLogStatus(value: string): value is ActivityLogStatus {
  return ACTIVITY_LOG_STATUSES.includes(value as ActivityLogStatus);
}

export async function listActivityLogs(input: {
  sellerId: string;
  status?: ActivityLogStatus;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  limit: number;
}): Promise<SafeActivityLogRow[]> {
  let query = supabase
    .from("activity_logs")
    .select("*")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (input.status) query = query.eq("status", input.status);
  if (input.eventType) query = query.eq("event_type", input.eventType);
  if (input.entityType) query = query.eq("entity_type", input.entityType);
  if (input.entityId) query = query.eq("entity_id", input.entityId);

  const { data, error } = await query;

  if (error) {
    logActivityError("Could not list activity logs.", error);
    throw new Error("Could not load activity logs from Supabase.");
  }

  return ((data ?? []) as ActivityLogRow[]).map(toSafeActivityLog);
}

export async function getActivityLogById(id: string): Promise<SafeActivityLogRow | null> {
  const { data, error } = await supabase
    .from("activity_logs")
    .select("*")
    .eq("id", id)
    .maybeSingle<ActivityLogRow>();

  if (error) {
    logActivityError("Could not load activity log.", error);
    throw new Error("Could not load activity log from Supabase.");
  }

  return data ? toSafeActivityLog(data) : null;
}

export async function createActivityLog(input: ActivityLogInput): Promise<SafeActivityLogRow> {
  const { data, error } = await supabase
    .from("activity_logs")
    .insert(toInsertRow(input))
    .select("*")
    .single<ActivityLogRow>();

  if (error || !data) {
    if (error) {
      logActivityError("Could not create activity log.", error);
    }
    throw new Error("Could not create activity log in Supabase.");
  }

  return toSafeActivityLog(data);
}

export async function deleteActivityLog(id: string): Promise<string | null> {
  const existing = await getActivityLogById(id);

  if (!existing) {
    return null;
  }

  const { error } = await supabase
    .from("activity_logs")
    .delete()
    .eq("id", id);

  if (error) {
    logActivityError("Could not delete activity log.", error);
    throw new Error("Could not delete activity log from Supabase.");
  }

  return id;
}
