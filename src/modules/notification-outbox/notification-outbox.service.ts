import { supabase } from "../../db/supabase";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { checkSecurityGuardrail } from "../security-guardrails/security-guardrails.service";
import {
  NotificationOutboxRow,
  NotificationSettingsRow,
  SafeNotificationOutboxMessage,
  SafeNotificationSettings
} from "./notification-outbox.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toSafeMessage(row: NotificationOutboxRow): SafeNotificationOutboxMessage {
  return {
    id: row.id,
    sellerId: row.seller_id,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    message: row.message,
    status: row.status,
    sourceModule: row.source_module,
    sourceId: row.source_id,
    severity: row.severity,
    sendAttempts: toNumber(row.send_attempts),
    lastError: row.last_error,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at,
    sentAt: row.sent_at
  };
}

function toSafeSettings(row: NotificationSettingsRow): SafeNotificationSettings {
  return {
    id: row.id,
    sellerId: row.seller_id,
    externalNotificationsEnabled: Boolean(row.external_notifications_enabled),
    emailEnabled: Boolean(row.email_enabled),
    whatsappEnabled: Boolean(row.whatsapp_enabled),
    slackEnabled: Boolean(row.slack_enabled),
    defaultEmail: row.default_email,
    defaultPhone: row.default_phone,
    defaultSlackWebhook: row.default_slack_webhook,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function initializeNotificationSettings(sellerIdInput: string): Promise<SafeNotificationSettings> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("notification_settings")
    .upsert({
      seller_id: sellerId,
      external_notifications_enabled: false,
      email_enabled: false,
      whatsapp_enabled: false,
      slack_enabled: false,
      updated_at: new Date().toISOString()
    }, { onConflict: "seller_id" })
    .select("*")
    .single<NotificationSettingsRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not initialize notification settings.");
  return toSafeSettings(data);
}

export async function getNotificationSettings(sellerIdInput: string): Promise<SafeNotificationSettings> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<NotificationSettingsRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeSettings(data) : initializeNotificationSettings(sellerId);
}

export async function queueNotification(input: {
  sellerId?: string | null;
  channel: string;
  recipient?: string | null;
  subject?: string | null;
  message: string;
  sourceModule?: string | null;
  sourceId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SafeNotificationOutboxMessage> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const { data, error } = await supabase
    .from("notification_outbox")
    .insert({
      seller_id: sellerId,
      channel: cleanText(input.channel)?.toUpperCase() ?? "INTERNAL",
      recipient: cleanText(input.recipient),
      subject: cleanText(input.subject),
      message: cleanText(input.message) ?? "Notification",
      status: "QUEUED",
      source_module: cleanText(input.sourceModule),
      source_id: cleanText(input.sourceId),
      severity: cleanText(input.severity)?.toUpperCase() ?? "INFO",
      metadata: input.metadata ?? {}
    })
    .select("*")
    .single<NotificationOutboxRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not queue notification.");
  const row = toSafeMessage(data);
  await safeRecordActivityLog({
    sellerId,
    eventType: "NOTIFICATION_QUEUED",
    eventCategory: "NOTIFICATION",
    severity: row.severity === "CRITICAL" ? "CRITICAL" : row.severity === "HIGH" ? "WARNING" : "INFO",
    actor: "system",
    title: "Notification queued",
    message: "Notification queued internally. No external send attempted.",
    sourceModule: "notification-outbox",
    metadata: { notificationId: row.id, channel: row.channel, sourceModule: row.sourceModule }
  });
  return row;
}

export async function listNotificationMessages(input: { sellerId: string; limit: number }): Promise<SafeNotificationOutboxMessage[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("notification_outbox")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as NotificationOutboxRow[]).map(toSafeMessage);
}

async function getNotificationById(id: string): Promise<SafeNotificationOutboxMessage | null> {
  const { data, error } = await supabase
    .from("notification_outbox")
    .select("*")
    .eq("id", id)
    .maybeSingle<NotificationOutboxRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeMessage(data) : null;
}

function providerConfigured(settings: SafeNotificationSettings, channel: string): boolean {
  if (!settings.externalNotificationsEnabled) return false;
  if (channel === "EMAIL") return settings.emailEnabled && Boolean(settings.defaultEmail);
  if (channel === "WHATSAPP") return settings.whatsappEnabled && Boolean(settings.defaultPhone);
  if (channel === "SLACK") return settings.slackEnabled && Boolean(settings.defaultSlackWebhook);
  return false;
}

export async function sendNotification(input: {
  id: string;
  actor?: string | null;
}): Promise<{ ok: boolean; message: SafeNotificationOutboxMessage | null; blockedReason: string | null }> {
  const existing = await getNotificationById(input.id);
  if (!existing) return { ok: false, message: null, blockedReason: "NOTIFICATION_NOT_FOUND" };
  const security = await checkSecurityGuardrail({
    sellerId: existing.sellerId,
    actor: cleanText(input.actor) ?? "founder",
    action: "NOTIFICATION_SEND",
    route: "/api/notification-outbox/send/:id",
    metadata: { notificationId: existing.id, channel: existing.channel }
  });
  const settings = await getNotificationSettings(existing.sellerId);
  const blockedReason = !security.allowed
    ? security.reason ?? "SECURITY_GUARDRAIL_BLOCKED"
    : !settings.externalNotificationsEnabled
      ? "EXTERNAL_NOTIFICATIONS_DISABLED"
      : !providerConfigured(settings, existing.channel)
        ? "BLOCKED_PROVIDER_NOT_CONFIGURED"
        : "BLOCKED_PROVIDER_NOT_CONFIGURED";

  const { data, error } = await supabase
    .from("notification_outbox")
    .update({
      status: "BLOCKED_PROVIDER_NOT_CONFIGURED",
      send_attempts: existing.sendAttempts + 1,
      last_error: blockedReason
    })
    .eq("id", existing.id)
    .select("*")
    .single<NotificationOutboxRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not update notification send attempt.");

  return {
    ok: false,
    message: toSafeMessage(data),
    blockedReason
  };
}

export async function getNotificationOutboxSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  queuedCount: number;
  blockedCount: number;
  sentCount: number;
  externalNotificationsEnabled: boolean;
  providerConfigured: boolean;
  latestMessages: SafeNotificationOutboxMessage[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const settings = await getNotificationSettings(sellerId);
  const [queued, blocked, sent, latestMessages] = await Promise.all([
    supabase.from("notification_outbox").select("id", { count: "exact", head: true }).eq("seller_id", sellerId).eq("status", "QUEUED"),
    supabase.from("notification_outbox").select("id", { count: "exact", head: true }).eq("seller_id", sellerId).like("status", "BLOCKED%"),
    supabase.from("notification_outbox").select("id", { count: "exact", head: true }).eq("seller_id", sellerId).eq("status", "SENT"),
    listNotificationMessages({ sellerId, limit: 10 }).catch(() => [])
  ]);

  return {
    ok: true,
    sellerId,
    queuedCount: queued.count ?? 0,
    blockedCount: blocked.count ?? 0,
    sentCount: sent.count ?? 0,
    externalNotificationsEnabled: settings.externalNotificationsEnabled,
    providerConfigured:
      providerConfigured(settings, "EMAIL") ||
      providerConfigured(settings, "WHATSAPP") ||
      providerConfigured(settings, "SLACK"),
    latestMessages
  };
}
