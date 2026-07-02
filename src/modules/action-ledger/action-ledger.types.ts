export type ActionLedgerSource =
  | "CEO_REPORT"
  | "PPC_RECOMMENDATION"
  | "PRODUCT_ECONOMICS"
  | "LISTING_AI"
  | "A_PLUS_AI"
  | "IMAGE_AI"
  | "BRAND_STORE_AI"
  | "SOCIAL_AI"
  | "SYSTEM";

export type ActionLedgerActionType =
  | "PPC_ACTION"
  | "PROFIT_BAND_APPROVAL"
  | "LISTING_UPDATE"
  | "IMAGE_UPDATE"
  | "A_PLUS_UPDATE"
  | "BRAND_STORE_UPDATE"
  | "SOCIAL_POST"
  | "COST_DATA_UPDATE"
  | "SYNC_JOB"
  | "OTHER";

export type ActionLedgerEntityType =
  | "SKU"
  | "ASIN"
  | "CAMPAIGN"
  | "SEARCH_TERM"
  | "BRAND_STORE"
  | "SOCIAL_CHANNEL"
  | "ACCOUNT";

export type ActionLedgerRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ActionLedgerConfidenceLabel = "LOW" | "MEDIUM" | "HIGH";
export type ActionLedgerApprovalTier = "TIER_1" | "TIER_2" | "TIER_3" | "FOUNDER_OVERRIDE";

export type ActionLedgerState =
  | "DRAFTED"
  | "DATA_CHECKED"
  | "VALIDATED"
  | "WAITING_FOR_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "MONITORING"
  | "SUBMITTED"
  | "PROCESSING"
  | "LIVE_VERIFIED"
  | "COMPLETED"
  | "FAILED"
  | "AUTO_REPAIRING"
  | "NEEDS_FOUNDER_INPUT"
  | "ROLLBACK_SUGGESTED"
  | "ROLLED_BACK"
  | "CLOSED";

export type ActionLedgerApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "MONITOR" | "COMPLETED" | "EXPIRED";

export type ActionLedgerRow = {
  id: string;
  seller_id: string;
  source: ActionLedgerSource | string;
  source_id: string | null;
  action_type: ActionLedgerActionType | string;
  entity_type: ActionLedgerEntityType | string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  title: string;
  summary: string | null;
  recommended_action: string | null;
  expected_profit_impact: number | string | null;
  expected_sales_impact: number | string | null;
  expected_brand_impact: number | string | null;
  risk_level: ActionLedgerRiskLevel | string;
  confidence_label: ActionLedgerConfidenceLabel | string;
  approval_tier: ActionLedgerApprovalTier | string;
  requires_approval: boolean;
  state: ActionLedgerState | string;
  approval_status: ActionLedgerApprovalStatus | string;
  payload: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
  guardrails: Record<string, unknown> | null;
  rollback_snapshot: Record<string, unknown> | null;
  approval_note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type ActionLedgerInput = {
  sellerId?: string;
  source: ActionLedgerSource;
  sourceId?: string | null;
  actionType: ActionLedgerActionType;
  entityType?: ActionLedgerEntityType | null;
  entityId?: string | null;
  sku?: string | null;
  asin?: string | null;
  title: string;
  summary?: string | null;
  recommendedAction?: string | null;
  expectedProfitImpact?: number | null;
  expectedSalesImpact?: number | null;
  expectedBrandImpact?: number | null;
  riskLevel?: ActionLedgerRiskLevel;
  confidenceLabel?: ActionLedgerConfidenceLabel;
  approvalTier?: ActionLedgerApprovalTier;
  requiresApproval?: boolean;
  state?: ActionLedgerState;
  approvalStatus?: ActionLedgerApprovalStatus;
  payload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
  rollbackSnapshot?: Record<string, unknown> | null;
};

export type SafeActionLedgerRow = {
  id: string;
  sellerId: string;
  source: string;
  sourceId: string | null;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  title: string;
  summary: string | null;
  recommendedAction: string | null;
  expectedProfitImpact: number | null;
  expectedSalesImpact: number | null;
  expectedBrandImpact: number | null;
  riskLevel: string;
  confidenceLabel: string;
  approvalTier: string;
  requiresApproval: boolean;
  state: string;
  approvalStatus: string;
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  rollbackSnapshot: Record<string, unknown> | null;
  approvalNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ActionLedgerSummary = {
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  monitoringCount: number;
  completedCount: number;
  highRiskCount: number;
  founderOverrideCount: number;
  latestActions: SafeActionLedgerRow[];
};
