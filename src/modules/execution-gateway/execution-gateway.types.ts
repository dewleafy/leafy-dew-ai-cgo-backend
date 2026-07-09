export type ExecutionMode = "SHADOW" | "LIVE";
export type ExecutionStatus =
  | "PREVIEW_CREATED"
  | "SHADOW_COMPLETED"
  | "LIVE_BLOCKED"
  | "APPROVAL_REQUIRED"
  | "EXECUTION_NOT_IMPLEMENTED"
  | "SHADOW_FAILED";

export type ExecutionAttemptRow = {
  id: string;
  seller_id: string;
  action_id: string | null;
  source: string | null;
  source_id: string | null;
  action_type: string;
  entity_type: string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  execution_mode: string;
  execution_status: string;
  actor: string;
  request_payload: Record<string, unknown> | null;
  planned_change: Record<string, unknown> | null;
  snapshot_before: Record<string, unknown> | null;
  snapshot_after: Record<string, unknown> | null;
  rollback_snapshot: Record<string, unknown> | null;
  safety_checks: Record<string, unknown> | null;
  blocked_reason: string | null;
  result_message: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
};

export type SafeExecutionAttempt = {
  id: string;
  sellerId: string;
  actionId: string | null;
  source: string | null;
  sourceId: string | null;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  executionMode: string;
  executionStatus: string;
  actor: string;
  requestPayload: Record<string, unknown>;
  plannedChange: Record<string, unknown>;
  snapshotBefore: Record<string, unknown> | null;
  snapshotAfter: Record<string, unknown> | null;
  rollbackSnapshot: Record<string, unknown> | null;
  safetyChecks: Record<string, unknown>;
  blockedReason: string | null;
  resultMessage: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
};

export type ExecutionSafetyChecks = {
  shadowMode: true;
  externalExecution: false;
  liveExecutionEnabled: false;
  amazonUpdate: false;
  adsUpdate: false;
  listingUpdate: false;
  imageUpload: false;
  aPlusUpload: false;
  socialPost: false;
  aiCall: false;
  aiCallsEnabled: false;
  approvalRequired: true;
  safetyControl: Record<string, unknown>;
};
