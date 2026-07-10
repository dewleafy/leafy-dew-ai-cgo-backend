export type RollbackSnapshotRow = {
  id: string;
  seller_id: string;
  action_id: string | null;
  execution_attempt_id: string | null;
  source_module: string;
  entity_type: string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  snapshot_type: string;
  snapshot_status: string;
  before_state: Record<string, unknown> | null;
  planned_change: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  rollback_plan: Record<string, unknown> | null;
  rollback_status: string;
  captured_by: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeRollbackSnapshot = {
  id: string;
  sellerId: string;
  actionId: string | null;
  executionAttemptId: string | null;
  sourceModule: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  snapshotType: string;
  snapshotStatus: string;
  beforeState: Record<string, unknown>;
  plannedChange: Record<string, unknown>;
  afterState: Record<string, unknown> | null;
  rollbackPlan: Record<string, unknown>;
  rollbackStatus: string;
  capturedBy: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RollbackSummary = {
  ok: true;
  sellerId: string;
  totalSnapshots: number;
  capturedCount: number;
  failedCount: number;
  executedCount: number;
  notExecutedCount: number;
  latestSnapshots: SafeRollbackSnapshot[];
};
