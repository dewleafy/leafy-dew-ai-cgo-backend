import { supabase } from "../../db/supabase";
import { DangerousOperation, SafeSecurityAuditEvent, SecurityAuditEventRow } from "./security-guardrails.types";

const DANGEROUS_OPERATIONS = new Set<string>([
  "LIVE_PPC_EXECUTION",
  "LIVE_LISTING_EXECUTION",
  "LIVE_ROLLBACK_EXECUTION",
  "AI_GENERATE",
  "NOTIFICATION_SEND",
  "SAFETY_SETTING_UPDATE"
]);

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSafeEvent(row: SecurityAuditEventRow): SafeSecurityAuditEvent {
  return {
    id: row.id,
    sellerId: row.seller_id,
    actor: row.actor,
    eventType: row.event_type,
    route: row.route,
    action: row.action,
    allowed: Boolean(row.allowed),
    reason: row.reason,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

function isFounderOrAdmin(actor: string | null): boolean {
  const normalized = cleanText(actor)?.toLowerCase();
  return normalized === "founder" || normalized === "admin";
}

function requiresConfirmText(action: string): boolean {
  return action === "LIVE_PPC_EXECUTION" || action === "LIVE_LISTING_EXECUTION" || action === "LIVE_ROLLBACK_EXECUTION";
}

async function insertAudit(input: {
  sellerId: string;
  actor: string;
  eventType: string;
  route?: string | null;
  action?: string | null;
  allowed: boolean;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SafeSecurityAuditEvent> {
  const { data, error } = await supabase
    .from("security_audit_events")
    .insert({
      seller_id: input.sellerId,
      actor: input.actor,
      event_type: input.eventType,
      route: cleanText(input.route),
      action: cleanText(input.action),
      allowed: input.allowed,
      reason: cleanText(input.reason),
      metadata: input.metadata ?? {}
    })
    .select("*")
    .single<SecurityAuditEventRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not record security audit event.");
  return toSafeEvent(data);
}

export async function checkSecurityGuardrail(input: {
  sellerId?: string | null;
  actor?: string | null;
  action: DangerousOperation | string;
  route?: string | null;
  confirmText?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{
  ok: true;
  sellerId: string;
  action: string;
  allowed: boolean;
  reason: string | null;
  auditEvent: SafeSecurityAuditEvent;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const actor = cleanText(input.actor) ?? "unknown";
  const action = cleanText(input.action) ?? "UNKNOWN";
  let allowed = true;
  let reason: string | null = null;

  if (!DANGEROUS_OPERATIONS.has(action)) {
    allowed = false;
    reason = "UNSUPPORTED_DANGEROUS_OPERATION";
  } else if (!isFounderOrAdmin(actor)) {
    allowed = false;
    reason = "FOUNDER_OR_ADMIN_REQUIRED";
  } else if (requiresConfirmText(action) && cleanText(input.confirmText) !== "EXECUTE LIVE APPROVED ACTION") {
    allowed = false;
    reason = "CONFIRM_TEXT_REQUIRED";
  }

  const auditEvent = await insertAudit({
    sellerId,
    actor,
    eventType: allowed ? "SECURITY_GUARDRAIL_ALLOWED" : "SECURITY_GUARDRAIL_BLOCKED",
    route: input.route,
    action,
    allowed,
    reason,
    metadata: input.metadata
  });

  return { ok: true, sellerId, action, allowed, reason, auditEvent };
}

export async function listSecurityAuditEvents(input: { sellerId: string; limit: number }): Promise<SafeSecurityAuditEvent[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("security_audit_events")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as SecurityAuditEventRow[]).map(toSafeEvent);
}

export async function getSecurityGuardrailsSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalEvents: number;
  blockedEvents: number;
  allowedEvents: number;
  dangerousOperations: string[];
  latestEvents: SafeSecurityAuditEvent[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [total, blocked, allowed, latestEvents] = await Promise.all([
    supabase.from("security_audit_events").select("id", { count: "exact", head: true }).eq("seller_id", sellerId),
    supabase.from("security_audit_events").select("id", { count: "exact", head: true }).eq("seller_id", sellerId).eq("allowed", false),
    supabase.from("security_audit_events").select("id", { count: "exact", head: true }).eq("seller_id", sellerId).eq("allowed", true),
    listSecurityAuditEvents({ sellerId, limit: 10 }).catch(() => [])
  ]);

  return {
    ok: true,
    sellerId,
    totalEvents: total.count ?? 0,
    blockedEvents: blocked.count ?? 0,
    allowedEvents: allowed.count ?? 0,
    dangerousOperations: Array.from(DANGEROUS_OPERATIONS),
    latestEvents
  };
}
