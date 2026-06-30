export type AiRecommendationStatus =
  | "NEW"
  | "APPROVED"
  | "REJECTED"
  | "MONITORING"
  | "COMPLETED_MANUALLY"
  | "EXPIRED";

export type AiRecommendationRow = {
  id: string;
  seller_id: string;
  source: string;
  recommendation_type: string;
  recommended_action: string;
  entity_type: string | null;
  entity_value: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_group_id: string | null;
  ad_group_name: string | null;
  sku: string | null;
  asin: string | null;
  priority_score: number | string | null;
  priority_label: string | null;
  confidence_score: number | string | null;
  confidence_label: string | null;
  approval_tier: string | null;
  requires_approval: boolean | null;
  risk_level: string | null;
  expected_profit_impact: number | string | null;
  reason: string;
  evidence: Record<string, unknown> | null;
  profit_evidence: Record<string, unknown> | null;
  status: AiRecommendationStatus | null;
  user_note: string | null;
  rule_version: string | null;
  strategy_version: string | null;
  data_start_date: string | null;
  data_end_date: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeAiRecommendationRow = {
  id: string;
  sellerId: string;
  source: string;
  recommendationType: string;
  recommendedAction: string;
  entityType: string | null;
  entityValue: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  sku: string | null;
  asin: string | null;
  priorityScore: number;
  priorityLabel: string;
  confidenceScore: number;
  confidenceLabel: string;
  approvalTier: string;
  requiresApproval: boolean;
  riskLevel: string;
  expectedProfitImpact: number | null;
  reason: string;
  evidence: Record<string, unknown>;
  profitEvidence: Record<string, unknown>;
  safeWarning?: string;
  status: AiRecommendationStatus;
  userNote: string | null;
  ruleVersion: string;
  strategyVersion: string;
  dataStartDate: string | null;
  dataEndDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
