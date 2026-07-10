import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ActivityLogEventInput,
  ActivityLogEventRow,
  ActivityLogInput,
  ActivityLogSeverity,
  ActivityLogStatus,
  ActivityLogSummary,
  SafeActivityLogEvent,
  SafeActivityLogRow
} from "./activity-logs.types";

export const ACTIVITY_LOG_STATUSES: ActivityLogStatus[] = [
  "INFO",
  "SUCCESS",
  "WARNING",
  "ERROR",
  "CRITICAL"
];

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
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

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSeverity(value: unknown): ActivityLogSeverity {
  const severity = cleanText(value)?.toUpperCase();
  return severity && ACTIVITY_LOG_STATUSES.includes(severity as ActivityLogSeverity)
    ? (severity as ActivityLogSeverity)
    : "INFO";
}

function toSafeActivityEvent(row: ActivityLogEventRow): SafeActivityLogEvent {
  return {
    id: row.id,
    sellerId: row.seller_id,
    eventType: row.event_type,
    eventCategory: row.event_category,
    severity: toSeverity(row.severity),
    actor: row.actor,
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    actionId: row.action_id,
    sourceModule: row.source_module,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

function toInsertRow(input: ActivityLogEventInput): Record<string, unknown> {
  const title = cleanText(input.title) ?? cleanText(input.eventType) ?? "System activity";
  const eventType = cleanText(input.eventType) ?? "SYSTEM_EVENT";

  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    event_type: eventType,
    event_category: cleanText(input.eventCategory) ?? "SYSTEM",
    severity: toSeverity(input.severity),
    actor: cleanText(input.actor) ?? "system",
    title,
    message: cleanText(input.message),
    entity_type: cleanText(input.entityType),
    entity_id: cleanText(input.entityId),
    sku: cleanText(input.sku),
    asin: cleanText(input.asin),
    action_id: cleanText(input.actionId),
    source_module: cleanText(input.sourceModule),
    metadata: toJsonObject(input.metadata)
  };
}

async function countEvents(input: {
  sellerId: string;
  severity?: ActivityLogSeverity;
  sinceIso?: string;
}): Promise<number> {
  let query = supabase
    .from("activity_log_events")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId);

  if (input.severity) query = query.eq("severity", input.severity);
  if (input.sinceIso) query = query.gte("created_at", input.sinceIso);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export function isActivityLogStatus(value: string): value is ActivityLogStatus {
  return ACTIVITY_LOG_STATUSES.includes(value.toUpperCase() as ActivityLogStatus);
}

export async function listActivityLogEvents(input: {
  sellerId: string;
  severity?: ActivityLogSeverity;
  eventType?: string;
  eventCategory?: string;
  entityType?: string;
  entityId?: string;
  actionId?: string;
  sourceModule?: string;
  limit: number;
}): Promise<SafeActivityLogEvent[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  let query = supabase
    .from("activity_log_events")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.severity) query = query.eq("severity", input.severity);
  if (input.eventType) query = query.eq("event_type", input.eventType);
  if (input.eventCategory) query = query.eq("event_category", input.eventCategory);
  if (input.entityType) query = query.eq("entity_type", input.entityType);
  if (input.entityId) query = query.eq("entity_id", input.entityId);
  if (input.actionId) query = query.eq("action_id", input.actionId);
  if (input.sourceModule) query = query.eq("source_module", input.sourceModule);

  const { data, error } = await query;

  if (error) {
    logActivityError("Could not list activity log events.", error);
    throw new Error("Could not load activity log events from Supabase.");
  }

  return ((data ?? []) as ActivityLogEventRow[]).map(toSafeActivityEvent);
}

export async function getActivityLogSummary(sellerIdInput: string): Promise<ActivityLogSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [totalEvents, infoCount, warningCount, errorCount, criticalCount, todayEvents, latestEvents] = await Promise.all([
    countEvents({ sellerId }),
    countEvents({ sellerId, severity: "INFO" }),
    countEvents({ sellerId, severity: "WARNING" }),
    countEvents({ sellerId, severity: "ERROR" }),
    countEvents({ sellerId, severity: "CRITICAL" }),
    countEvents({ sellerId, sinceIso: todayStart.toISOString() }),
    listActivityLogEvents({ sellerId, limit: 10 })
  ]);

  return {
    ok: true,
    sellerId,
    totalEvents,
    infoCount,
    warningCount,
    errorCount,
    criticalCount,
    todayEvents,
    latestEvents
  };
}

export async function createActivityLogEvent(input: ActivityLogEventInput): Promise<SafeActivityLogEvent> {
  const { data, error } = await supabase
    .from("activity_log_events")
    .insert(toInsertRow(input))
    .select("*")
    .single<ActivityLogEventRow>();

  if (error || !data) {
    if (error) {
      logActivityError("Could not create activity log event.", error);
    }
    throw new Error("Could not create activity log event in Supabase.");
  }

  return toSafeActivityEvent(data);
}

export async function safeRecordActivityLog(input: ActivityLogEventInput): Promise<SafeActivityLogEvent | null> {
  try {
    return await createActivityLogEvent(input);
  } catch (error) {
    logger.warn("Activity log insert failed safely.", {
      sellerId: cleanText(input.sellerId) ?? "default",
      eventType: cleanText(input.eventType),
      sourceModule: cleanText(input.sourceModule),
      message: sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown activity log error")
    });
    return null;
  }
}

export async function getActivityLogById(id: string): Promise<SafeActivityLogRow | null> {
  const { data, error } = await supabase
    .from("activity_log_events")
    .select("*")
    .eq("id", id)
    .maybeSingle<ActivityLogEventRow>();

  if (error) {
    logActivityError("Could not load activity log event.", error);
    throw new Error("Could not load activity log event from Supabase.");
  }

  return data ? toSafeActivityEvent(data) : null;
}

export async function listActivityLogs(input: {
  sellerId: string;
  status?: ActivityLogStatus;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  limit: number;
}): Promise<SafeActivityLogRow[]> {
  return listActivityLogEvents({
    sellerId: input.sellerId,
    severity: input.status,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    limit: input.limit
  });
}

export async function createActivityLog(input: ActivityLogInput): Promise<SafeActivityLogRow> {
  return createActivityLogEvent({
    sellerId: input.sellerId,
    eventType: input.eventType,
    eventCategory: input.entityType ?? "LEGACY",
    severity: input.status ?? "INFO",
    actor: "system",
    title: input.action,
    message: input.message,
    entityType: input.entityType,
    entityId: input.entityId,
    sourceModule: "legacy_activity_logs",
    metadata: {
      ...(input.metadata ?? {}),
      entityLabel: input.entityLabel ?? null,
      userNote: input.userNote ?? null
    }
  });
}

export async function deleteActivityLog(id: string): Promise<string | null> {
  const existing = await getActivityLogById(id);

  if (!existing) {
    return null;
  }

  const { error } = await supabase
    .from("activity_log_events")
    .delete()
    .eq("id", id);

  if (error) {
    logActivityError("Could not delete activity log event.", error);
    throw new Error("Could not delete activity log event from Supabase.");
  }

  return id;
}
