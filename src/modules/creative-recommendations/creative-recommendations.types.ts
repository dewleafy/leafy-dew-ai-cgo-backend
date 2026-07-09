export type CreativeRecommendationType =
  | "MAIN_IMAGE_REVIEW"
  | "INFOGRAPHIC_IMAGE_REVIEW"
  | "LIFESTYLE_IMAGE_REVIEW"
  | "SIZE_CHART_IMAGE_REVIEW"
  | "A_PLUS_CONTENT_REVIEW"
  | "BRAND_STORY_REVIEW";

export type CreativeRecommendationRow = {
  id: string;
  seller_id: string;
  sku: string | null;
  asin: string | null;
  product_name: string | null;
  recommendation_type: CreativeRecommendationType | string;
  title: string;
  summary: string | null;
  recommended_action: string | null;
  source: string;
  source_id: string | null;
  action_id: string | null;
  status: string;
  confidence_label: string;
  risk_level: string;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeCreativeRecommendation = {
  id: string;
  sellerId: string;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  recommendationType: string;
  title: string;
  summary: string | null;
  recommendedAction: string | null;
  source: string;
  sourceId: string | null;
  actionId: string | null;
  status: string;
  confidenceLabel: string;
  riskLevel: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CreativeRecommendationGenerateResult = {
  ok: true;
  sellerId: string;
  scannedCount: number;
  recommendationsCreated: number;
  actionsCreated: number;
  skippedCount: number;
  rows: SafeCreativeRecommendation[];
};
