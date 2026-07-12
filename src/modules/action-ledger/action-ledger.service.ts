import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ActionLedgerActionType,
  ActionLedgerBatchUpdateResult,
  ActionLedgerApprovalStatus,
  ActionLedgerApprovalTier,
  ActionLedgerConfidenceLabel,
  ActionLedgerDailyPriorities,
  ActionLedgerEntityType,
  ActionLedgerInput,
  ActionLedgerRiskLevel,
  ActionLedgerRow,
  ActionLedgerSource,
  ActionLedgerState,
  ActionLedgerSummary,
  SafeActionLedgerRow
} from "./action-ledger.types";

export const ACTION_LEDGER_SOURCES: ActionLedgerSource[] = [
  "CEO_REPORT",
  "PPC_RECOMMENDATION",
  "PPC_RECOMMENDATIONS",
  "PRODUCT_ECONOMICS",
  "LISTING_AI",
  "A_PLUS_AI",
  "IMAGE_AI",
  "BRAND_STORE_AI",
  "SOCIAL_AI",
  "ENGINE_ROUTER",
  "LISTING_DRAFT_SYSTEM",
  "CREATIVE_RECOMMENDATION_SYSTEM",
  "SYSTEM"
];

export const ACTION_LEDGER_ACTION_TYPES: ActionLedgerActionType[] = [
  "PPC_ACTION",
  "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
  "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
  "PAUSE_WASTEFUL_TARGET_AFTER_APPROVAL",
  "REDUCE_BID_AFTER_APPROVAL",
  "INCREASE_BID_AFTER_APPROVAL",
  "NEGATE_SEARCH_TERM_AFTER_APPROVAL",
  "PPC_BUDGET_GUARDRAIL_REVIEW",
  "CHECK_LISTING_BEFORE_NEGATIVE",
  "PAUSE_OR_REDUCE_SPEND_AFTER_APPROVAL",
  "PPC_GUARDRAIL_REVIEW",
  "PROFIT_BAND_APPROVAL",
  "COST_DATA_REQUIRED",
  "PROFIT_RISK_REVIEW",
  "ACCOUNT_HEALTH_REVIEW",
  "LISTING_READINESS_REVIEW",
  "LISTING_SEO_REVIEW",
  "LISTING_CONVERSION_REVIEW",
  "PRICING_REVIEW",
  "INVENTORY_RISK_REVIEW",
  "LISTING_TITLE_DRAFT_REVIEW",
  "LISTING_BULLETS_DRAFT_REVIEW",
  "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW",
  "LISTING_DESCRIPTION_DRAFT_REVIEW",
  "IMAGE_CREATIVE_REVIEW",
  "A_PLUS_CONTENT_REVIEW",
  "LISTING_UPDATE",
  "IMAGE_UPDATE",
  "A_PLUS_UPDATE",
  "BRAND_STORE_UPDATE",
  "SOCIAL_POST",
  "COST_DATA_UPDATE",
  "SYNC_JOB",
  "OTHER"
];

export const ACTION_LEDGER_ENTITY_TYPES: ActionLedgerEntityType[] = [
  "SKU",
  "ASIN",
  "KEYWORD",
  "CAMPAIGN",
  "AD_GROUP",
  "SEARCH_TERM",
  "BRAND_STORE",
  "SOCIAL_CHANNEL",
  "ACCOUNT"
];

export const ACTION_LEDGER_RISK_LEVELS: ActionLedgerRiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const ACTION_LEDGER_CONFIDENCE_LABELS: ActionLedgerConfidenceLabel[] = ["LOW", "MEDIUM", "HIGH"];
export const ACTION_LEDGER_APPROVAL_TIERS: ActionLedgerApprovalTier[] = ["TIER_1", "TIER_2", "TIER_3", "FOUNDER_OVERRIDE"];

export const ACTION_LEDGER_STATES: ActionLedgerState[] = [
  "DRAFTED",
  "DATA_CHECKED",
  "VALIDATED",
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "REJECTED",
  "MONITOR",
  "MONITORING",
  "SUBMITTED",
  "PROCESSING",
  "LIVE_VERIFIED",
  "COMPLETED",
  "FAILED",
  "AUTO_REPAIRING",
  "NEEDS_FOUNDER_INPUT",
  "ROLLBACK_SUGGESTED",
  "ROLLED_BACK",
  "CLOSED"
];

export const ACTION_LEDGER_APPROVAL_STATUSES: ActionLedgerApprovalStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "MONITOR",
  "COMPLETED",
  "EXPIRED"
];

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalizeActionId(input: unknown): string {
  const raw =
    typeof input === "string"
      ? input
      : typeof input === "object" && input !== null && "id" in input
        ? String((input as { id?: unknown }).id || "")
        : "";

  return raw
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function logActionLedgerError(context: string, error: { message?: string; code?: string; details?: string; hint?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined,
    details: error.details ? sanitizeErrorMessage(error.details) : undefined,
    hint: error.hint ? sanitizeErrorMessage(error.hint) : undefined
  });
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNullableJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeEnum<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

export function isActionLedgerSource(value: string): value is ActionLedgerSource {
  return ACTION_LEDGER_SOURCES.includes(value as ActionLedgerSource);
}

export function isActionLedgerActionType(value: string): value is ActionLedgerActionType {
  return ACTION_LEDGER_ACTION_TYPES.includes(value as ActionLedgerActionType);
}

export function isActionLedgerEntityType(value: string): value is ActionLedgerEntityType {
  return ACTION_LEDGER_ENTITY_TYPES.includes(value as ActionLedgerEntityType);
}

export function isActionLedgerRiskLevel(value: string): value is ActionLedgerRiskLevel {
  return ACTION_LEDGER_RISK_LEVELS.includes(value as ActionLedgerRiskLevel);
}

export function isActionLedgerConfidenceLabel(value: string): value is ActionLedgerConfidenceLabel {
  return ACTION_LEDGER_CONFIDENCE_LABELS.includes(value as ActionLedgerConfidenceLabel);
}

export function isActionLedgerApprovalTier(value: string): value is ActionLedgerApprovalTier {
  return ACTION_LEDGER_APPROVAL_TIERS.includes(value as ActionLedgerApprovalTier);
}

export function isActionLedgerState(value: string): value is ActionLedgerState {
  return ACTION_LEDGER_STATES.includes(value as ActionLedgerState);
}

export function isActionLedgerApprovalStatus(value: string): value is ActionLedgerApprovalStatus {
  return ACTION_LEDGER_APPROVAL_STATUSES.includes(value as ActionLedgerApprovalStatus);
}

export function toSafeActionLedgerRow(row: ActionLedgerRow): SafeActionLedgerRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    source: safeEnum(row.source, ACTION_LEDGER_SOURCES, "SYSTEM"),
    sourceId: row.source_id,
    actionType: safeEnum(row.action_type, ACTION_LEDGER_ACTION_TYPES, "OTHER"),
    entityType: row.entity_type ? safeEnum(row.entity_type, ACTION_LEDGER_ENTITY_TYPES, "ACCOUNT") : null,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    title: row.title,
    summary: row.summary,
    recommendedAction: row.recommended_action,
    expectedProfitImpact: toNumberOrNull(row.expected_profit_impact),
    expectedSalesImpact: toNumberOrNull(row.expected_sales_impact),
    expectedBrandImpact: toNumberOrNull(row.expected_brand_impact),
    riskLevel: safeEnum(row.risk_level, ACTION_LEDGER_RISK_LEVELS, "MEDIUM"),
    confidenceLabel: safeEnum(row.confidence_label, ACTION_LEDGER_CONFIDENCE_LABELS, "MEDIUM"),
    approvalTier: safeEnum(row.approval_tier, ACTION_LEDGER_APPROVAL_TIERS, "TIER_2"),
    requiresApproval: Boolean(row.requires_approval),
    state: safeEnum(row.state, ACTION_LEDGER_STATES, "DRAFTED"),
    approvalStatus: safeEnum(row.approval_status, ACTION_LEDGER_APPROVAL_STATUSES, "PENDING"),
    payload: toJsonObject(row.payload),
    evidence: toJsonObject(row.evidence),
    guardrails: toJsonObject(row.guardrails),
    rollbackSnapshot: toNullableJsonObject(row.rollback_snapshot),
    approvalNote: row.approval_note,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapActionLedgerRow(row: ActionLedgerRow): SafeActionLedgerRow {
  return toSafeActionLedgerRow(row);
}

function defaultStateForInput(input: ActionLedgerInput): ActionLedgerState {
  if (input.state) return input.state;
  return input.requiresApproval === false ? "VALIDATED" : "WAITING_FOR_APPROVAL";
}

function defaultApprovalStatusForInput(input: ActionLedgerInput): ActionLedgerApprovalStatus {
  if (input.approvalStatus) return input.approvalStatus;
  return input.requiresApproval === false ? "APPROVED" : "PENDING";
}

function toInsertRow(input: ActionLedgerInput): Record<string, unknown> {
  const requiresApproval = input.requiresApproval ?? true;

  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    source: input.source,
    source_id: cleanText(input.sourceId),
    action_type: input.actionType,
    entity_type: cleanText(input.entityType),
    entity_id: cleanText(input.entityId),
    sku: cleanText(input.sku),
    asin: cleanText(input.asin),
    title: input.title.trim(),
    summary: cleanText(input.summary),
    recommended_action: cleanText(input.recommendedAction),
    expected_profit_impact: input.expectedProfitImpact ?? null,
    expected_sales_impact: input.expectedSalesImpact ?? null,
    expected_brand_impact: input.expectedBrandImpact ?? null,
    risk_level: input.riskLevel ?? "MEDIUM",
    confidence_label: input.confidenceLabel ?? "MEDIUM",
    approval_tier: input.approvalTier ?? "TIER_2",
    requires_approval: requiresApproval,
    state: defaultStateForInput({ ...input, requiresApproval }),
    approval_status: defaultApprovalStatusForInput({ ...input, requiresApproval }),
    payload: toJsonObject(input.payload),
    evidence: toJsonObject(input.evidence),
    guardrails: toJsonObject(input.guardrails),
    rollback_snapshot: toNullableJsonObject(input.rollbackSnapshot)
  };
}

export async function listActionLedgerRows(input: {
  sellerId: string;
  approvalStatus?: ActionLedgerApprovalStatus;
  state?: ActionLedgerState;
  actionType?: ActionLedgerActionType;
  sku?: string;
  asin?: string;
  limit: number;
}): Promise<SafeActionLedgerRow[]> {
  let query = supabase
    .from("action_ledger")
    .select("*")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (input.approvalStatus) query = query.eq("approval_status", input.approvalStatus);
  if (input.state) query = query.eq("state", input.state);
  if (input.actionType) query = query.eq("action_type", input.actionType);
  if (input.sku) query = query.eq("sku", input.sku);
  if (input.asin) query = query.eq("asin", input.asin);

  const { data, error } = await query;

  if (error) {
    logActionLedgerError("Could not list action ledger rows.", error);
    throw new Error("Could not load action ledger from Supabase.");
  }

  return ((data ?? []) as ActionLedgerRow[]).map(toSafeActionLedgerRow);
}

export async function getActionLedgerById(id: unknown): Promise<SafeActionLedgerRow | null> {
  const cleanId = canonicalizeActionId(id);

  if (!cleanId) {
    return null;
  }

  const { data, error } = await supabase.rpc(
    "get_action_ledger_by_id_text",
    { p_id: cleanId }
  );

  if (error) {
    console.warn("Could not load action ledger row by RPC.", {
      id: cleanId,
      message: error.message,
      code: error.code
    });
    throw new Error(error.message);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row ? mapActionLedgerRow(row as ActionLedgerRow) : null;
}

export const getActionLedgerRowById = getActionLedgerById;

export async function createActionLedgerRow(input: ActionLedgerInput): Promise<SafeActionLedgerRow> {
  const { data, error } = await supabase
    .from("action_ledger")
    .insert(toInsertRow(input))
    .select("*")
    .single<ActionLedgerRow>();

  if (error || !data) {
    if (error) logActionLedgerError("Could not create action ledger row.", error);
    throw new Error("Could not create action ledger row in Supabase.");
  }

  return toSafeActionLedgerRow(data);
}

function applyNullableDedupeFilter<T extends { eq: (column: string, value: string) => T; is: (column: string, value: null) => T }>(
  query: T,
  column: string,
  value: string | null | undefined
): T {
  const cleaned = cleanText(value);
  return cleaned ? query.eq(column, cleaned) : query.is(column, null);
}

export async function ensureActionLedgerAction(input: ActionLedgerInput): Promise<{ row: SafeActionLedgerRow; created: boolean }> {
  const insertRow = toInsertRow(input);
  const sellerId = String(insertRow.seller_id);
  const source = String(insertRow.source);
  const actionType = String(insertRow.action_type);

  let query = supabase
    .from("action_ledger")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("source", source)
    .eq("action_type", actionType)
    .limit(1);

  query = applyNullableDedupeFilter(query, "source_id", insertRow.source_id as string | null);
  query = applyNullableDedupeFilter(query, "entity_type", insertRow.entity_type as string | null);
  query = applyNullableDedupeFilter(query, "entity_id", insertRow.entity_id as string | null);
  query = applyNullableDedupeFilter(query, "sku", insertRow.sku as string | null);
  query = applyNullableDedupeFilter(query, "asin", insertRow.asin as string | null);

  const { data: existing, error: loadError } = await query.maybeSingle<ActionLedgerRow>();

  if (loadError) {
    logActionLedgerError("Could not check action ledger duplicate.", loadError);
    throw new Error("Could not check action ledger duplicate in Supabase.");
  }

  if (existing) {
    return {
      row: toSafeActionLedgerRow(existing),
      created: false
    };
  }

  return {
    row: await createActionLedgerRow(input),
    created: true
  };
}

export async function updateActionLedgerApprovalState(input: {
  id: string;
  approvalStatus: ActionLedgerApprovalStatus;
  state: ActionLedgerState;
  note?: string | null;
  approvedBy?: string | null;
}): Promise<SafeActionLedgerRow | null> {
  const cleanId = canonicalizeActionId(input.id);

  if (!cleanId) {
    return null;
  }

  const { data, error } = await supabase.rpc(
    "update_action_ledger_state_by_id_text",
    {
      p_id: cleanId,
      p_approval_status: input.approvalStatus,
      p_state: input.state,
      p_note: input.note || null,
      p_approved_by: input.approvedBy || "founder"
    }
  );

  if (error) {
    console.warn("Could not update action ledger row by RPC.", {
      id: cleanId,
      message: error.message,
      code: error.code
    });
    throw new Error(error.message);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row ? mapActionLedgerRow(row as ActionLedgerRow) : null;
}

function uniqueActionLedgerIds(ids: string[]): string[] {
  return [...new Set(ids.map(canonicalizeActionId).filter(Boolean))];
}

function applyBatchSafetyFilters<T extends {
  eq: (column: string, value: string) => T;
  in: (column: string, values: string[]) => T;
  neq: (column: string, value: string) => T;
}>(
  query: T,
  input: {
    onlyApprovalStatus?: ActionLedgerApprovalStatus;
    allowedApprovalStatuses?: ActionLedgerApprovalStatus[];
    allowedStates?: string[];
    source?: ActionLedgerSource;
    actionType?: ActionLedgerActionType;
    excludeRiskLevels?: ActionLedgerRiskLevel[];
    excludeApprovalTiers?: ActionLedgerApprovalTier[];
  }
): T {
  let filteredQuery = query;

  if (input.onlyApprovalStatus) filteredQuery = filteredQuery.eq("approval_status", input.onlyApprovalStatus);
  if (input.allowedApprovalStatuses?.length) filteredQuery = filteredQuery.in("approval_status", input.allowedApprovalStatuses);
  if (input.allowedStates?.length) filteredQuery = filteredQuery.in("state", input.allowedStates);
  if (input.source) filteredQuery = filteredQuery.eq("source", input.source);
  if (input.actionType) filteredQuery = filteredQuery.eq("action_type", input.actionType);

  for (const riskLevel of input.excludeRiskLevels ?? []) {
    filteredQuery = filteredQuery.neq("risk_level", riskLevel);
  }

  for (const approvalTier of input.excludeApprovalTiers ?? []) {
    filteredQuery = filteredQuery.neq("approval_tier", approvalTier);
  }

  return filteredQuery;
}

export async function batchUpdateActionLedgerState(input: {
  sellerId: string;
  ids: string[];
  approvalStatus: ActionLedgerApprovalStatus;
  state: ActionLedgerState;
  note?: string | null;
  markRejectedAt?: boolean;
  onlyApprovalStatus?: ActionLedgerApprovalStatus;
  allowedApprovalStatuses?: ActionLedgerApprovalStatus[];
  allowedStates?: string[];
  source?: ActionLedgerSource;
  actionType?: ActionLedgerActionType;
  excludeRiskLevels?: ActionLedgerRiskLevel[];
  excludeApprovalTiers?: ActionLedgerApprovalTier[];
}): Promise<ActionLedgerBatchUpdateResult> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const requestedCount = input.ids.length;
  const ids = uniqueActionLedgerIds(input.ids);
  const now = new Date().toISOString();
  const updateRow: Record<string, unknown> = {
    approval_status: input.approvalStatus,
    state: input.state,
    approval_note: cleanText(input.note),
    updated_at: now
  };

  if (input.markRejectedAt) {
    updateRow.rejected_at = now;
  }

  if (!ids.length) {
    logger.info("Action ledger batch update completed.", {
      sellerId,
      requestedCount,
      updatedCount: 0,
      skippedCount: requestedCount
    });

    return {
      sellerId,
      requestedCount,
      updatedCount: 0,
      skippedCount: requestedCount,
      rows: [],
      workflowBeforeRows: []
    };
  }

  let beforeQuery = supabase
    .from("action_ledger")
    .select("*")
    .eq("seller_id", sellerId)
    .in("id", ids);

  beforeQuery = applyBatchSafetyFilters(beforeQuery, input);

  const { data: beforeData, error: beforeError } = await beforeQuery;

  if (beforeError) {
    logActionLedgerError("Could not load action ledger rows before batch update.", beforeError);
    throw new Error("Could not load action ledger rows before batch update in Supabase.");
  }

  const workflowBeforeRows = (beforeData ?? []) as ActionLedgerRow[];
  const updateIds = workflowBeforeRows.map((row) => row.id);

  if (!updateIds.length) {
    logger.info("Action ledger batch update completed.", {
      sellerId,
      requestedCount,
      updatedCount: 0,
      skippedCount: requestedCount
    });

    return {
      sellerId,
      requestedCount,
      updatedCount: 0,
      skippedCount: requestedCount,
      rows: [],
      workflowBeforeRows
    };
  }

  let query = supabase
    .from("action_ledger")
    .update(updateRow)
    .eq("seller_id", sellerId)
    .in("id", updateIds);

  query = applyBatchSafetyFilters(query, input);

  const { data, error } = await query.select("*");

  if (error) {
    logActionLedgerError("Could not batch update action ledger rows.", error);
    throw new Error("Could not batch update action ledger rows in Supabase.");
  }

  const rows = ((data ?? []) as ActionLedgerRow[]).map(toSafeActionLedgerRow);
  const updatedCount = rows.length;
  const skippedCount = Math.max(requestedCount - updatedCount, 0);

  logger.info("Action ledger batch update completed.", {
    sellerId,
    requestedCount,
    updatedCount,
    skippedCount
  });

  return {
    sellerId,
    requestedCount,
    updatedCount,
    skippedCount,
    rows,
    workflowBeforeRows
  };
}

async function listPendingActionLedgerRowsForPrioritySort(sellerId: string): Promise<SafeActionLedgerRow[]> {
  const pageSize = 1000;
  const rows: SafeActionLedgerRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("action_ledger")
      .select("*")
      .eq("seller_id", sellerId)
      .eq("approval_status", "PENDING")
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      logActionLedgerError("Could not list pending action ledger rows for daily priorities.", error);
      throw new Error("Could not load action ledger daily priorities from Supabase.");
    }

    const pageRows = ((data ?? []) as ActionLedgerRow[]).map(toSafeActionLedgerRow);
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      return rows;
    }
  }
}

export async function dismissLowPriorityActionLedgerRows(input: {
  sellerId: string;
  source?: ActionLedgerSource;
  actionType?: ActionLedgerActionType;
  limit: number;
  note?: string | null;
}): Promise<ActionLedgerBatchUpdateResult> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);

  let query = supabase
    .from("action_ledger")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("approval_status", "PENDING")
    .neq("risk_level", "HIGH")
    .neq("risk_level", "CRITICAL")
    .neq("approval_tier", "FOUNDER_OVERRIDE")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.source) query = query.eq("source", input.source);
  if (input.actionType) query = query.eq("action_type", input.actionType);

  const { data, error } = await query;

  if (error) {
    logActionLedgerError("Could not find low-priority action ledger rows to dismiss.", error);
    throw new Error("Could not find low-priority action ledger rows in Supabase.");
  }

  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);

  return batchUpdateActionLedgerState({
    sellerId,
    ids,
    approvalStatus: "REJECTED",
    state: "REJECTED",
    note: input.note,
    markRejectedAt: true,
    onlyApprovalStatus: "PENDING",
    source: input.source,
    actionType: input.actionType,
    excludeRiskLevels: ["HIGH", "CRITICAL"],
    excludeApprovalTiers: ["FOUNDER_OVERRIDE"]
  });
}

function riskPriority(row: SafeActionLedgerRow): number {
  if (row.riskLevel === "CRITICAL") return 0;
  if (row.riskLevel === "HIGH") return 1;
  return 2;
}

function approvalTierPriority(row: SafeActionLedgerRow): number {
  return row.approvalTier === "FOUNDER_OVERRIDE" ? 0 : 1;
}

function sourcePriority(row: SafeActionLedgerRow): number {
  if (row.source === "CEO_REPORT") return 0;
  if (row.source === "PRODUCT_ECONOMICS") return 1;
  if (row.source === "PPC_RECOMMENDATIONS" || row.source === "PPC_RECOMMENDATION") return 2;
  return 3;
}

function createdAtMillis(row: SafeActionLedgerRow): number {
  const value = row.createdAt ? Date.parse(row.createdAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

export async function getDailyPriorities(input: {
  sellerId: string;
  limit: number;
}): Promise<ActionLedgerDailyPriorities> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
  const [totalPending, pendingRows] = await Promise.all([
    countRows({ sellerId, approvalStatus: "PENDING" }),
    listPendingActionLedgerRowsForPrioritySort(sellerId)
  ]);

  const rows = pendingRows
    .sort((a, b) => {
      const riskDiff = riskPriority(a) - riskPriority(b);
      if (riskDiff) return riskDiff;

      const approvalTierDiff = approvalTierPriority(a) - approvalTierPriority(b);
      if (approvalTierDiff) return approvalTierDiff;

      const sourceDiff = sourcePriority(a) - sourcePriority(b);
      if (sourceDiff) return sourceDiff;

      return createdAtMillis(b) - createdAtMillis(a);
    })
    .slice(0, limit);

  return {
    sellerId,
    limit,
    totalPending,
    rows
  };
}

async function countRows(input: {
  sellerId: string;
  approvalStatus?: ActionLedgerApprovalStatus;
  riskLevel?: ActionLedgerRiskLevel;
  approvalTier?: ActionLedgerApprovalTier;
}): Promise<number> {
  let query = supabase
    .from("action_ledger")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", cleanText(input.sellerId) ?? "default");

  if (input.approvalStatus) query = query.eq("approval_status", input.approvalStatus);
  if (input.riskLevel) query = query.eq("risk_level", input.riskLevel);
  if (input.approvalTier) query = query.eq("approval_tier", input.approvalTier);

  const { count, error } = await query;

  if (error) {
    logActionLedgerError("Could not count action ledger rows.", error);
    throw new Error("Could not summarize action ledger from Supabase.");
  }

  return count ?? 0;
}

export async function getActionLedgerSummary(sellerIdInput: string): Promise<ActionLedgerSummary> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [
    pendingCount,
    approvedCount,
    rejectedCount,
    monitoringCount,
    completedCount,
    highRiskCount,
    founderOverrideCount,
    latestActions
  ] = await Promise.all([
    countRows({ sellerId, approvalStatus: "PENDING" }),
    countRows({ sellerId, approvalStatus: "APPROVED" }),
    countRows({ sellerId, approvalStatus: "REJECTED" }),
    countRows({ sellerId, approvalStatus: "MONITOR" }),
    countRows({ sellerId, approvalStatus: "COMPLETED" }),
    countRows({ sellerId, riskLevel: "HIGH" }),
    countRows({ sellerId, approvalTier: "FOUNDER_OVERRIDE" }),
    listActionLedgerRows({ sellerId, limit: 10 })
  ]);

  return {
    pendingCount,
    approvedCount,
    rejectedCount,
    monitoringCount,
    completedCount,
    highRiskCount,
    founderOverrideCount,
    latestActions
  };
}

function mapProfitBandApprovalTier(value: string | null | undefined): ActionLedgerApprovalTier {
  if (value === "FOUNDER_OVERRIDE_REQUIRED") return "FOUNDER_OVERRIDE";
  if (value === "HIGH_RISK_APPROVAL") return "TIER_3";
  if (value === "PROFIT_BAND_APPROVAL") return "TIER_2";
  return "TIER_2";
}

function mapRiskLevel(value: unknown): ActionLedgerRiskLevel {
  const label = String(value ?? "MEDIUM").toUpperCase();
  if (label === "VERY_HIGH" || label === "CRITICAL") return "CRITICAL";
  if (label === "HIGH") return "HIGH";
  if (label === "LOW") return "LOW";
  return "MEDIUM";
}

function normalizeSourcePart(value: unknown): string {
  const cleaned = cleanText(value == null ? "" : String(value));
  return cleaned?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.:-]+/g, "-") ?? "unknown";
}

function isAsinLike(value: string | null | undefined): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(value ?? "");
}

function mapRecommendationActionType(value: string | null | undefined): ActionLedgerActionType {
  const action = String(value ?? "").toUpperCase();
  if (action === "ADD_EXACT_KEYWORD_AFTER_APPROVAL") return "ADD_EXACT_KEYWORD_AFTER_APPROVAL";
  if (action === "ADD_PRODUCT_TARGET_AFTER_APPROVAL") return "ADD_PRODUCT_TARGET_AFTER_APPROVAL";
  if (action === "CHECK_LISTING_BEFORE_NEGATIVE") return "CHECK_LISTING_BEFORE_NEGATIVE";
  if (action === "LOWER_BID_AFTER_APPROVAL" || action === "ADD_NEGATIVE_AFTER_APPROVAL") return "PAUSE_OR_REDUCE_SPEND_AFTER_APPROVAL";
  return "PPC_GUARDRAIL_REVIEW";
}

function getStableRecommendationSourceId(recommendation: Record<string, unknown>, entityValue: string | null, asin: string | null, recommendedAction: string | null): string {
  const campaignId = recommendation.campaignId ?? recommendation.campaign_id;
  const adGroupId = recommendation.adGroupId ?? recommendation.ad_group_id;
  const actionType = mapRecommendationActionType(recommendedAction);

  if (actionType === "ADD_PRODUCT_TARGET_AFTER_APPROVAL") {
    return `ppc:product-target:${normalizeSourcePart(campaignId)}:${normalizeSourcePart(adGroupId)}:${normalizeSourcePart(asin ?? entityValue)}`;
  }

  return `ppc:keyword:${normalizeSourcePart(campaignId)}:${normalizeSourcePart(adGroupId)}:${normalizeSourcePart(entityValue)}:exact`;
}

export async function createProfitBandApprovalAction(input: {
  sellerId?: string;
  sourceId?: string | null;
  sku?: string | null;
  asin?: string | null;
  productName?: string | null;
  profitBand: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
}): Promise<SafeActionLedgerRow> {
  const bandLabel = String(input.profitBand.bandLabel ?? input.profitBand.band_label ?? "lower profit band");
  const approvalTier = mapProfitBandApprovalTier(String(input.profitBand.approvalTier ?? input.profitBand.approval_tier ?? ""));

  const ensured = await ensureActionLedgerAction({
    sellerId: input.sellerId ?? "default",
    source: "PRODUCT_ECONOMICS",
    sourceId: input.sourceId ?? null,
    actionType: "PROFIT_BAND_APPROVAL",
    entityType: "SKU",
    entityId: cleanText(input.sku),
    sku: input.sku ?? null,
    asin: input.asin ?? null,
    title: `Approve ${bandLabel} profit band${input.productName ? ` for ${input.productName}` : ""}`,
    summary: "Approval request for temporary lower profit band. No external action will be executed.",
    recommendedAction: "APPROVE_PROFIT_BAND",
    expectedProfitImpact: toNumberOrNull(input.profitBand.minProfit),
    expectedSalesImpact: null,
    expectedBrandImpact: null,
    riskLevel: mapRiskLevel(input.profitBand.riskLevel ?? input.profitBand.risk_level),
    confidenceLabel: "MEDIUM",
    approvalTier,
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      profitBand: input.profitBand,
      externalExecution: false,
      shadowMode: true
    },
    evidence: input.evidence ?? {},
    guardrails: {
      externalExecution: false,
      shadowMode: true,
      ...(input.guardrails ?? {})
    }
  });
  return ensured.row;
}

export async function createActionFromRecommendation(recommendation: Record<string, unknown>): Promise<SafeActionLedgerRow> {
  const sellerId = cleanText(String(recommendation.sellerId ?? recommendation.seller_id ?? "default")) ?? "default";
  const entityValue = cleanText(String(recommendation.entityValue ?? recommendation.entity_value ?? ""));
  const recommendedAction = cleanText(String(recommendation.recommendedAction ?? recommendation.recommended_action ?? "REVIEW_RECOMMENDATION"));
  const title = cleanText(String(recommendation.title ?? recommendedAction ?? "Review recommendation")) ?? "Review recommendation";
  const asin = cleanText(String(recommendation.asin ?? "")) ?? (isAsinLike(entityValue) ? entityValue?.toUpperCase() ?? null : null);
  const actionType = mapRecommendationActionType(recommendedAction);
  const entityType: ActionLedgerEntityType | null = asin || actionType === "ADD_PRODUCT_TARGET_AFTER_APPROVAL"
    ? "ASIN"
    : entityValue
      ? "KEYWORD"
      : null;

  const ensured = await ensureActionLedgerAction({
    sellerId,
    source: "PPC_RECOMMENDATIONS",
    sourceId: getStableRecommendationSourceId(recommendation, entityValue, asin, recommendedAction),
    actionType,
    entityType,
    entityId: asin ?? entityValue,
    sku: cleanText(String(recommendation.sku ?? "")),
    asin,
    title,
    summary: cleanText(String(recommendation.reason ?? recommendation.summary ?? "")),
    recommendedAction,
    expectedProfitImpact: toNumberOrNull(recommendation.expectedProfitImpact ?? recommendation.expected_profit_impact),
    expectedSalesImpact: null,
    expectedBrandImpact: null,
    riskLevel: mapRiskLevel(recommendation.riskLevel ?? recommendation.risk_level),
    confidenceLabel: safeEnum(String(recommendation.confidenceLabel ?? recommendation.confidence_label ?? "MEDIUM"), ACTION_LEDGER_CONFIDENCE_LABELS, "MEDIUM"),
    approvalTier: safeEnum(String(recommendation.approvalTier ?? recommendation.approval_tier ?? "TIER_2"), ACTION_LEDGER_APPROVAL_TIERS, "TIER_2"),
    requiresApproval: true,
    payload: {
      recommendation,
      externalExecution: false,
      shadowMode: true
    },
    evidence: toJsonObject(recommendation.evidence),
    guardrails: {
      externalExecution: false,
      shadowMode: true
    }
  });
  return ensured.row;
}
