export type LearningEventType =
  | "ACTION_CREATED"
  | "ACTION_APPROVED"
  | "ACTION_REJECTED"
  | "ACTION_MONITORING"
  | "ACTION_COMPLETED"
  | "ACTION_REOPENED"
  | "COST_DATA_AUTO_RESOLVED"
  | "ENGINE_PREVIEW_ACTION_CREATED"
  | "ENGINE_PREVIEW_NO_ACTION"
  | "ENGINE_SKIPPED_NO_DATA"
  | "ENGINE_SKIPPED_TEMPLATE_NOT_IMPLEMENTED"
  | "ENGINE_FAILED"
  | "DUPLICATE_ACTION_SKIPPED"
  | "MANUAL_OUTCOME_NOTE"
  | "SHADOW_EXECUTION_PREVIEWED"
  | "SHADOW_EXECUTION_COMPLETED"
  | "LIVE_EXECUTION_BLOCKED"
  | "SHADOW_EXECUTION_FAILED"
  | "LISTING_DRAFT_CREATED"
  | "IMAGE_A_PLUS_RECOMMENDATION_CREATED";

export type ActionLearningEventRow = {
  id: string;
  seller_id: string;
  action_id: string | null;
  engine_key: string | null;
  source: string | null;
  source_id: string | null;
  action_type: string | null;
  entity_type: string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  event_type: LearningEventType | string;
  outcome_status: string;
  actor: string;
  note: string | null;
  before_metrics: Record<string, unknown> | null;
  after_metrics: Record<string, unknown> | null;
  observed_profit_impact: number | string | null;
  observed_sales_impact: number | string | null;
  observed_brand_impact: number | string | null;
  confidence_before: string | null;
  confidence_after: string | null;
  evidence: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

export type EngineLearningSummaryRow = {
  id: string;
  seller_id: string;
  engine_key: string;
  total_actions_created: number | string;
  approved_count: number | string;
  rejected_count: number | string;
  monitoring_count: number | string;
  completed_count: number | string;
  reopened_count: number | string;
  duplicate_skipped_count: number | string;
  no_action_count: number | string;
  failed_count: number | string;
  usefulness_score: number | string;
  confidence_score: number | string;
  last_learning_event_at: string | null;
  last_summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeActionLearningEvent = {
  id: string;
  sellerId: string;
  actionId: string | null;
  engineKey: string | null;
  source: string | null;
  sourceId: string | null;
  actionType: string | null;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  eventType: string;
  outcomeStatus: string;
  actor: string;
  note: string | null;
  beforeMetrics: Record<string, unknown> | null;
  afterMetrics: Record<string, unknown> | null;
  observedProfitImpact: number | null;
  observedSalesImpact: number | null;
  observedBrandImpact: number | null;
  confidenceBefore: string | null;
  confidenceAfter: string | null;
  evidence: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string | null;
};

export type SafeEngineLearningSummary = {
  id: string;
  sellerId: string;
  engineKey: string;
  totalActionsCreated: number;
  approvedCount: number;
  rejectedCount: number;
  monitoringCount: number;
  completedCount: number;
  reopenedCount: number;
  duplicateSkippedCount: number;
  noActionCount: number;
  failedCount: number;
  usefulnessScore: number;
  confidenceScore: number;
  lastLearningEventAt: string | null;
  lastSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type LearningEventInput = {
  sellerId?: string | null;
  actionId?: string | null;
  engineKey?: string | null;
  source?: string | null;
  sourceId?: string | null;
  actionType?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  sku?: string | null;
  asin?: string | null;
  eventType: LearningEventType;
  outcomeStatus?: string | null;
  actor?: string | null;
  note?: string | null;
  beforeMetrics?: Record<string, unknown> | null;
  afterMetrics?: Record<string, unknown> | null;
  observedProfitImpact?: number | null;
  observedSalesImpact?: number | null;
  observedBrandImpact?: number | null;
  confidenceBefore?: string | null;
  confidenceAfter?: string | null;
  evidence?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};
