import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  SafeSafetyAuditEvent,
  SafeSafetyControlSettings,
  SafetyAuditEventRow,
  SafetyControlPatchInput,
  SafetyControlSettingsRow,
  SafetySnapshot
} from "./safety-control.types";

const LIVE_FLAG_KEYS = [
  "liveExecutionEnabled",
  "ppcLiveExecutionEnabled",
  "listingLiveExecutionEnabled",
  "imageLiveExecutionEnabled",
  "aPlusLiveExecutionEnabled",
  "socialLiveExecutionEnabled",
  "aiCallsEnabled"
] as const;

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toSafeSettings(row: SafetyControlSettingsRow): SafeSafetyControlSettings {
  return {
    id: row.id,
    sellerId: row.seller_id,
    globalMode: row.global_mode,
    liveExecutionEnabled: false,
    ppcLiveExecutionEnabled: false,
    listingLiveExecutionEnabled: false,
    imageLiveExecutionEnabled: false,
    aPlusLiveExecutionEnabled: false,
    socialLiveExecutionEnabled: false,
    aiCallsEnabled: false,
    approvalRequired: true,
    founderApprovalRequired: true,
    maxDailyEngineRuns: toNumber(row.max_daily_engine_runs, 50),
    maxDailyAiCost: toNumber(row.max_daily_ai_cost, 0),
    maxDailyExecutionAttempts: toNumber(row.max_daily_execution_attempts, 25),
    approvalTierRules: toJsonObject(row.approval_tier_rules),
    blockedActionTypes: toJsonArray(row.blocked_action_types),
    safetyNotes: row.safety_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeAuditEvent(row: SafetyAuditEventRow): SafeSafetyAuditEvent {
  return {
    id: row.id,
    sellerId: row.seller_id,
    eventType: row.event_type,
    actor: row.actor,
    beforeState: row.before_state,
    afterState: row.after_state,
    note: row.note,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

export function buildSafetySnapshot(settings: SafeSafetyControlSettings | null): SafetySnapshot {
  return {
    shadowMode: true,
    liveExecutionEnabled: false,
    approvalRequired: true,
    aiCallsEnabled: false,
    externalExecution: false,
    settings,
    message: "Live execution remains blocked in V1."
  };
}

async function recordSafetyAuditEvent(input: {
  sellerId: string;
  eventType: string;
  actor?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("safety_audit_events").insert({
    seller_id: cleanText(input.sellerId) ?? "default",
    event_type: input.eventType,
    actor: cleanText(input.actor) ?? "system",
    before_state: input.beforeState ?? null,
    after_state: input.afterState ?? null,
    note: cleanText(input.note),
    metadata: input.metadata ?? {}
  });

  if (error) {
    logger.warn("Safety audit event could not be recorded.", {
      sellerId: input.sellerId,
      eventType: input.eventType,
      message: error.message
    });
  }
}

export async function getSafetyControlSettings(sellerIdInput: string): Promise<SafeSafetyControlSettings | null> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("safety_control_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<SafetyControlSettingsRow>();

  if (error) throw new Error(error.message);
  return data ? toSafeSettings(data) : null;
}

export async function initializeSafetyControl(sellerIdInput: string, actor = "system"): Promise<{
  settings: SafeSafetyControlSettings;
  created: boolean;
  snapshot: SafetySnapshot;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const existing = await getSafetyControlSettings(sellerId);
  if (existing) {
    return { settings: existing, created: false, snapshot: buildSafetySnapshot(existing) };
  }

  const { data, error } = await supabase
    .from("safety_control_settings")
    .insert({
      seller_id: sellerId,
      global_mode: "SHADOW",
      live_execution_enabled: false,
      ppc_live_execution_enabled: false,
      listing_live_execution_enabled: false,
      image_live_execution_enabled: false,
      a_plus_live_execution_enabled: false,
      social_live_execution_enabled: false,
      ai_calls_enabled: false,
      approval_required: true,
      founder_approval_required: true
    })
    .select("*")
    .single<SafetyControlSettingsRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not initialize Safety Control.");

  const settings = toSafeSettings(data);
  await recordSafetyAuditEvent({
    sellerId,
    eventType: "SAFETY_CONTROL_INITIALIZED",
    actor,
    afterState: settings as unknown as Record<string, unknown>,
    note: "Safety Control initialized in shadow mode."
  });

  return { settings, created: true, snapshot: buildSafetySnapshot(settings) };
}

function hasLiveEnableAttempt(input: SafetyControlPatchInput): boolean {
  return LIVE_FLAG_KEYS.some((key) => input[key] === true);
}

function buildUpdateRow(input: SafetyControlPatchInput): Record<string, unknown> {
  const updateRow: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (input.globalMode !== undefined) updateRow.global_mode = cleanText(input.globalMode) ?? "SHADOW";
  updateRow.live_execution_enabled = false;
  updateRow.ppc_live_execution_enabled = false;
  updateRow.listing_live_execution_enabled = false;
  updateRow.image_live_execution_enabled = false;
  updateRow.a_plus_live_execution_enabled = false;
  updateRow.social_live_execution_enabled = false;
  updateRow.ai_calls_enabled = false;
  updateRow.approval_required = true;
  updateRow.founder_approval_required = true;

  if (input.maxDailyEngineRuns !== undefined) updateRow.max_daily_engine_runs = Math.max(Math.floor(input.maxDailyEngineRuns), 0);
  if (input.maxDailyAiCost !== undefined) updateRow.max_daily_ai_cost = Math.max(input.maxDailyAiCost, 0);
  if (input.maxDailyExecutionAttempts !== undefined) {
    updateRow.max_daily_execution_attempts = Math.max(Math.floor(input.maxDailyExecutionAttempts), 0);
  }
  if (input.approvalTierRules !== undefined) updateRow.approval_tier_rules = input.approvalTierRules;
  if (input.blockedActionTypes !== undefined) updateRow.blocked_action_types = input.blockedActionTypes;
  if (input.safetyNotes !== undefined) updateRow.safety_notes = cleanText(input.safetyNotes);

  return updateRow;
}

export async function patchSafetyControlSettings(input: {
  sellerId: string;
  patch: SafetyControlPatchInput;
}): Promise<{ settings: SafeSafetyControlSettings; snapshot: SafetySnapshot; liveEnableBlocked: boolean }> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const initialized = await initializeSafetyControl(sellerId, cleanText(input.patch.actor) ?? "system");
  const before = initialized.settings;
  const liveEnableBlocked = hasLiveEnableAttempt(input.patch);
  const { data, error } = await supabase
    .from("safety_control_settings")
    .update(buildUpdateRow(input.patch))
    .eq("seller_id", sellerId)
    .select("*")
    .single<SafetyControlSettingsRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not update Safety Control.");

  const settings = toSafeSettings(data);
  await recordSafetyAuditEvent({
    sellerId,
    eventType: liveEnableBlocked ? "LIVE_ENABLE_BLOCKED" : "SAFETY_SETTINGS_UPDATED",
    actor: input.patch.actor,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: settings as unknown as Record<string, unknown>,
    note: liveEnableBlocked ? "A V1 request tried to enable live execution or AI calls and was blocked." : input.patch.note,
    metadata: { requestedPatch: input.patch, v1LiveExecutionBlocked: true, aiCallsBlocked: true }
  });

  return { settings, snapshot: buildSafetySnapshot(settings), liveEnableBlocked };
}

export async function listSafetyAuditEvents(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeSafetyAuditEvent[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("safety_audit_events")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return ((data ?? []) as SafetyAuditEventRow[]).map(toSafeAuditEvent);
}

export async function getSafetyControlSnapshotSafe(sellerIdInput: string): Promise<SafetySnapshot> {
  try {
    const settings = (await getSafetyControlSettings(sellerIdInput)) ?? null;
    return buildSafetySnapshot(settings);
  } catch (error) {
    logger.warn("Safety Control snapshot unavailable; using V1 locked fallback.", {
      sellerId: cleanText(sellerIdInput) ?? "default",
      message: error instanceof Error ? error.message : "Unknown safety error"
    });
    return buildSafetySnapshot(null);
  }
}
