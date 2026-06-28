export type ExperimentType =
  | "PPC_KEYWORD_TEST"
  | "PPC_PRODUCT_TARGET_TEST"
  | "LISTING_CONTENT_TEST"
  | "IMAGE_TEST"
  | "PRICE_TEST"
  | "BUNDLE_TEST"
  | "BRAND_CONTENT_TEST"
  | "OTHER";

export type ExperimentStatus =
  | "PLANNED"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ExperimentPriority = "LOW" | "MEDIUM" | "HIGH";

export type ExperimentInput = {
  sellerId: string;
  experimentName: string;
  experimentType: ExperimentType;
  productPassportId?: string | null;
  sku?: string | null;
  asin?: string | null;
  campaignId?: string | null;
  adGroupId?: string | null;
  recommendationId?: string | null;
  hypothesis?: string | null;
  expectedResult?: string | null;
  successMetric?: string | null;
  beforeMetrics?: Record<string, unknown>;
  afterMetrics?: Record<string, unknown>;
  resultSummary?: string | null;
  learningNote?: string | null;
  status?: ExperimentStatus;
  priority?: ExperimentPriority;
  startDate?: string | null;
  endDate?: string | null;
};

export type ExperimentUpdateInput = Partial<ExperimentInput>;

export type ExperimentRow = {
  id: string;
  seller_id: string;
  experiment_name: string;
  experiment_type: ExperimentType;
  product_passport_id: string | null;
  sku: string | null;
  asin: string | null;
  campaign_id: string | null;
  ad_group_id: string | null;
  recommendation_id: string | null;
  hypothesis: string | null;
  expected_result: string | null;
  success_metric: string | null;
  before_metrics: Record<string, unknown> | null;
  after_metrics: Record<string, unknown> | null;
  result_summary: string | null;
  learning_note: string | null;
  status: ExperimentStatus;
  priority: ExperimentPriority;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeExperimentRow = {
  id: string;
  sellerId: string;
  experimentName: string;
  experimentType: ExperimentType;
  productPassportId: string | null;
  sku: string | null;
  asin: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  recommendationId: string | null;
  hypothesis: string | null;
  expectedResult: string | null;
  successMetric: string | null;
  beforeMetrics: Record<string, unknown>;
  afterMetrics: Record<string, unknown>;
  resultSummary: string | null;
  learningNote: string | null;
  status: ExperimentStatus;
  priority: ExperimentPriority;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
};
