import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  ActionLedgerActionType,
  ActionLedgerApprovalStatus,
  ActionLedgerApprovalTier,
  ActionLedgerConfidenceLabel,
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
  "PRODUCT_ECONOMICS",
  "LISTING_AI",
  "A_PLUS_AI",
  "IMAGE_AI",
  "BRAND_STORE_AI",
  "SOCIAL_AI",
  "SYSTEM"
];

export const ACTION_LEDGER_ACTION_TYPES: ActionLedgerActionType[] = [
  "PPC_ACTION",
  "PROFIT_BAND_APPROVAL",
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
  "CAMPAIGN",
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

export class ActionLedgerUpdateError extends Error {
  detail: string;

  constructor(detail: string) {
    super("Could not update action ledger row in Supabase.");
    this.name = "ActionLedgerUpdateError";
    this.detail = detail;
  }
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

export async function getActionLedgerRowById(id: string): Promise<SafeActionLedgerRow | null> {
  const { data, error } = await supabase
    .from("action_ledger")
    .select("*")
    .eq("id", id)
    .maybeSingle<ActionLedgerRow>();

  if (error) {
    logActionLedgerError("Could not load action ledger row.", error);
    throw new Error("Could not load action ledger row from Supabase.");
  }

  return data ? toSafeActionLedgerRow(data) : null;
}

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

export async function updateActionLedgerApprovalState(input: {
  id: string;
  approvalStatus: ActionLedgerApprovalStatus;
  state: ActionLedgerState;
  note?: string | null;
  approvedBy?: string | null;
}): Promise<SafeActionLedgerRow | null> {
  const now = new Date().toISOString();
  const updateRow: Record<string, unknown> = {
    approval_status: input.approvalStatus,
    state: input.state,
    approval_note: cleanText(input.note) ?? null,
    updated_at: now
  };

  if (input.approvalStatus === "APPROVED") {
    updateRow.approved_at = now;
    updateRow.approved_by = cleanText(input.approvedBy) ?? "founder";
  }

  if (input.approvalStatus === "REJECTED") {
    updateRow.rejected_at = now;
  }

  const { data, error } = await supabase
    .from("action_ledger")
    .update(updateRow)
    .eq("id", input.id)
    .select("*")
    .single<ActionLedgerRow>();

  if (error || !data) {
    if (error?.code === "PGRST116") {
      return null;
    }

    if (error) {
      logActionLedgerError("Could not update action ledger row.", error);
      throw new ActionLedgerUpdateError(sanitizeErrorMessage(error.message));
    }

    throw new ActionLedgerUpdateError("No row returned from Supabase.");
  }

  return toSafeActionLedgerRow(data);
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

  return createActionLedgerRow({
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
}

export async function createActionFromRecommendation(recommendation: Record<string, unknown>): Promise<SafeActionLedgerRow> {
  const sellerId = cleanText(String(recommendation.sellerId ?? recommendation.seller_id ?? "default")) ?? "default";
  const entityValue = cleanText(String(recommendation.entityValue ?? recommendation.entity_value ?? ""));
  const recommendedAction = cleanText(String(recommendation.recommendedAction ?? recommendation.recommended_action ?? "REVIEW_RECOMMENDATION"));
  const title = cleanText(String(recommendation.title ?? recommendedAction ?? "Review recommendation")) ?? "Review recommendation";

  return createActionLedgerRow({
    sellerId,
    source: "PPC_RECOMMENDATION",
    sourceId: cleanText(String(recommendation.id ?? "")),
    actionType: "PPC_ACTION",
    entityType: entityValue ? "SEARCH_TERM" : null,
    entityId: entityValue,
    sku: cleanText(String(recommendation.sku ?? "")),
    asin: cleanText(String(recommendation.asin ?? "")),
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
}
