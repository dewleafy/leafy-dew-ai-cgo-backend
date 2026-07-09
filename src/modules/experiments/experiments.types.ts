export type ExperimentType =
  | "PPC_BID_TEST"
  | "PPC_KEYWORD_TEST"
  | "LISTING_TITLE_TEST"
  | "LISTING_IMAGE_TEST"
  | "PRICING_TEST"
  | "COUPON_TEST"
  | "CONTENT_A_PLUS_TEST"
  | "INVENTORY_REPLENISHMENT_TEST"
  | "PPC_PRODUCT_TARGET_TEST"
  | "LISTING_CONTENT_TEST"
  | "IMAGE_TEST"
  | "PRICE_TEST"
  | "BUNDLE_TEST"
  | "BRAND_CONTENT_TEST"
  | "OTHER";

export type ExperimentStatus =
  | "DRAFT"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELLED"
  | "PLANNED"
  | "ACTIVE"
  | "PAUSED"
  | "FAILED";

export type ExperimentResultStatus = "WON" | "LOST" | "INCONCLUSIVE";
export type ExperimentPriority = "LOW" | "MEDIUM" | "HIGH";

export type ExperimentInput = {
  sellerId?: string;
  experimentKey?: string | null;
  name?: string;
  experimentName?: string;
  description?: string | null;
  experimentType: ExperimentType;
  status?: ExperimentStatus;
  actionId?: string | null;
  engineKey?: string | null;
  sku?: string | null;
  asin?: string | null;
  hypothesis?: string | null;
  baselineMetrics?: Record<string, unknown>;
  targetMetrics?: Record<string, unknown>;
  currentMetrics?: Record<string, unknown>;
  resultSummary?: string | null;
  resultStatus?: ExperimentResultStatus | null;
  startedAt?: string | null;
  endedAt?: string | null;
  productPassportId?: string | null;
  campaignId?: string | null;
  adGroupId?: string | null;
  recommendationId?: string | null;
  expectedResult?: string | null;
  successMetric?: string | null;
  beforeMetrics?: Record<string, unknown>;
  afterMetrics?: Record<string, unknown>;
  learningNote?: string | null;
  priority?: ExperimentPriority;
  startDate?: string | null;
  endDate?: string | null;
};

export type ExperimentUpdateInput = Partial<ExperimentInput>;

export type ExperimentRow = {
  id: string;
  seller_id: string;
  experiment_key: string | null;
  name: string | null;
  description: string | null;
  experiment_type: ExperimentType | string;
  status: ExperimentStatus | string;
  action_id: string | null;
  engine_key: string | null;
  sku: string | null;
  asin: string | null;
  hypothesis: string | null;
  baseline_metrics: Record<string, unknown> | null;
  target_metrics: Record<string, unknown> | null;
  current_metrics: Record<string, unknown> | null;
  result_summary: string | null;
  result_status: ExperimentResultStatus | string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  experiment_name?: string | null;
  product_passport_id?: string | null;
  campaign_id?: string | null;
  ad_group_id?: string | null;
  recommendation_id?: string | null;
  expected_result?: string | null;
  success_metric?: string | null;
  before_metrics?: Record<string, unknown> | null;
  after_metrics?: Record<string, unknown> | null;
  learning_note?: string | null;
  priority?: ExperimentPriority | string;
  start_date?: string | null;
  end_date?: string | null;
};

export type ExperimentEventRow = {
  id: string;
  seller_id: string;
  experiment_id: string;
  event_type: string;
  actor: string;
  note: string | null;
  metrics_snapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SafeExperimentRow = {
  id: string;
  sellerId: string;
  experimentKey: string | null;
  name: string;
  experimentName: string;
  description: string | null;
  experimentType: string;
  status: string;
  actionId: string | null;
  engineKey: string | null;
  sku: string | null;
  asin: string | null;
  hypothesis: string | null;
  baselineMetrics: Record<string, unknown>;
  targetMetrics: Record<string, unknown>;
  currentMetrics: Record<string, unknown>;
  resultSummary: string | null;
  resultStatus: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  productPassportId: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  recommendationId: string | null;
  expectedResult: string | null;
  successMetric: string | null;
  beforeMetrics: Record<string, unknown>;
  afterMetrics: Record<string, unknown>;
  learningNote: string | null;
  priority: string;
  startDate: string | null;
  endDate: string | null;
};

export type SafeExperimentEvent = {
  id: string;
  sellerId: string;
  experimentId: string;
  eventType: string;
  actor: string;
  note: string | null;
  metricsSnapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};
