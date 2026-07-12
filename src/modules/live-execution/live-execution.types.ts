import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";

export type LiveExecutionDomain = "PPC" | "LISTING";
export type LiveRunStatus = "BLOCKED" | "DRY_RUN_COMPLETED" | "LIVE_EXECUTED" | "FAILED";

export type LiveExecutionRunRow = {
  id: string;
  seller_id: string;
  action_id: string | null;
  execution_attempt_id: string | null;
  rollback_snapshot_id: string | null;
  execution_domain: string;
  action_type: string;
  entity_type: string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  live_status: string;
  dry_run_status: string | null;
  actor: string;
  confirm_text: string | null;
  request_payload: Record<string, unknown>;
  execution_plan: Record<string, unknown>;
  preflight_result: Record<string, unknown>;
  external_response: Record<string, unknown> | null;
  blocked_reason: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
};

export type SafeLiveExecutionRun = {
  id: string;
  sellerId: string;
  actionId: string | null;
  executionAttemptId: string | null;
  rollbackSnapshotId: string | null;
  executionDomain: string;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  liveStatus: string;
  dryRunStatus: string | null;
  actor: string;
  confirmText: string | null;
  requestPayload: Record<string, unknown>;
  executionPlan: Record<string, unknown>;
  preflightResult: Record<string, unknown>;
  externalResponse: Record<string, unknown> | null;
  blockedReason: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
};

export type LiveExecutionPlan = {
  domain: LiveExecutionDomain;
  planType: string;
  actionId: string;
  actionType: string;
  sellerId: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  externalExecution: boolean;
  mutationClientConfigured: boolean;
  supported: boolean;
  blockedReason: string | null;
  steps: Array<Record<string, unknown>>;
  payload: Record<string, unknown>;
};

export type AdapterStatus = {
  configured: boolean;
  reason: string;
};

export type AdapterExecutionResult = {
  ok: boolean;
  configured: boolean;
  blockedReason: string | null;
  externalResponse: Record<string, unknown> | null;
};

export type PreflightCheck = {
  key: string;
  status: "PASS" | "WARN" | "BLOCKED";
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  metadata?: Record<string, unknown>;
};

export type PreflightResult = {
  ok: boolean;
  sellerId: string;
  actionId: string;
  mode: "DRY_RUN" | "LIVE";
  executionDomain: LiveExecutionDomain | null;
  actionType: string | null;
  checks: PreflightCheck[];
  blockers: string[];
  warnings: string[];
  blockedReason: string | null;
  safetyChecks: Record<string, unknown>;
  action?: SafeActionLedgerRow;
  latestDryRun?: SafeLiveExecutionRun | null;
  rollbackSnapshotId?: string | null;
};

export type LiveExecutionRequest = {
  sellerId?: string | null;
  actor?: string | null;
  confirmText?: string | null;
  requestPayload?: Record<string, unknown>;
};

export const REQUIRED_LIVE_CONFIRM_TEXT = "EXECUTE LIVE APPROVED ACTION";

export const SUPPORTED_PPC_LIVE_ACTION_TYPES = new Set([
  "ADD_EXACT_KEYWORD_AFTER_APPROVAL",
  "ADD_PRODUCT_TARGET_AFTER_APPROVAL",
  "PAUSE_WASTEFUL_TARGET_AFTER_APPROVAL",
  "REDUCE_BID_AFTER_APPROVAL",
  "INCREASE_BID_AFTER_APPROVAL",
  "NEGATE_SEARCH_TERM_AFTER_APPROVAL",
  "PPC_BUDGET_GUARDRAIL_REVIEW"
]);

export const SUPPORTED_LISTING_LIVE_ACTION_TYPES = new Set([
  "LISTING_TITLE_DRAFT_REVIEW",
  "LISTING_BULLETS_DRAFT_REVIEW",
  "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW",
  "LISTING_DESCRIPTION_DRAFT_REVIEW"
]);
