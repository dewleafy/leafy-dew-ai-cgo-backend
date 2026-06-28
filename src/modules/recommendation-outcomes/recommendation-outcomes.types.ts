export type RecommendationOutcomeStatus =
  | "WORKED"
  | "FAILED"
  | "NEEDS_MORE_DATA"
  | "PARTIAL"
  | "NOT_APPLICABLE";

export type RecommendationOutcomeInput = {
  sellerId: string;
  experimentId?: string | null;
  outcomeStatus?: RecommendationOutcomeStatus;
  evaluationWindowDays?: number;
  beforeMetrics?: Record<string, unknown>;
  afterMetrics?: Record<string, unknown>;
  profitImpact?: number | null;
  salesImpact?: number | null;
  costImpact?: number | null;
  acosBefore?: number | null;
  acosAfter?: number | null;
  ordersBefore?: number | null;
  ordersAfter?: number | null;
  confidenceAfter?: number | null;
  resultSummary?: string | null;
  learningNote?: string | null;
};

export type RecommendationOutcomeUpdateInput = Partial<RecommendationOutcomeInput>;

export type RecommendationOutcomeEvaluateInput = {
  outcomeStatus: RecommendationOutcomeStatus;
  afterMetrics: Record<string, unknown>;
  resultSummary?: string | null;
  learningNote?: string | null;
};

export type RecommendationOutcomeRow = {
  id: string;
  seller_id: string;
  recommendation_id: string;
  experiment_id: string | null;
  outcome_status: RecommendationOutcomeStatus;
  evaluation_window_days: number;
  before_metrics: Record<string, unknown> | null;
  after_metrics: Record<string, unknown> | null;
  profit_impact: number | string | null;
  sales_impact: number | string | null;
  cost_impact: number | string | null;
  acos_before: number | string | null;
  acos_after: number | string | null;
  orders_before: number | null;
  orders_after: number | null;
  confidence_after: number | string | null;
  result_summary: string | null;
  learning_note: string | null;
  evaluated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeRecommendationOutcomeRow = {
  id: string;
  sellerId: string;
  recommendationId: string;
  experimentId: string | null;
  outcomeStatus: RecommendationOutcomeStatus;
  evaluationWindowDays: number;
  beforeMetrics: Record<string, unknown>;
  afterMetrics: Record<string, unknown>;
  profitImpact: number | null;
  salesImpact: number | null;
  costImpact: number | null;
  acosBefore: number | null;
  acosAfter: number | null;
  ordersBefore: number | null;
  ordersAfter: number | null;
  confidenceAfter: number | null;
  resultSummary: string | null;
  learningNote: string | null;
  evaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
