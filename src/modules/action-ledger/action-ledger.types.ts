export type ActionLedgerSource =
  | "CEO_REPORT"
  | "PPC_RECOMMENDATION"
  | "PPC_RECOMMENDATIONS"
  | "PRODUCT_ECONOMICS"
  | "LISTING_AI"
  | "A_PLUS_AI"
  | "IMAGE_AI"
  | "BRAND_STORE_AI"
  | "SOCIAL_AI"
  | "ENGINE_ROUTER"
  | "LISTING_DRAFT_SYSTEM"
  | "CREATIVE_RECOMMENDATION_SYSTEM"
  | "SYSTEM";

export type ActionLedgerActionType =
  | "PPC_ACTION"
  | "ADD_EXACT_KEYWORD_AFTER_APPROVAL"
  | "ADD_PRODUCT_TARGET_AFTER_APPROVAL"
  | "PAUSE_WASTEFUL_TARGET_AFTER_APPROVAL"
  | "REDUCE_BID_AFTER_APPROVAL"
  | "INCREASE_BID_AFTER_APPROVAL"
  | "NEGATE_SEARCH_TERM_AFTER_APPROVAL"
  | "PPC_BUDGET_GUARDRAIL_REVIEW"
  | "CHECK_LISTING_BEFORE_NEGATIVE"
  | "PAUSE_OR_REDUCE_SPEND_AFTER_APPROVAL"
  | "PPC_GUARDRAIL_REVIEW"
  | "PROFIT_BAND_APPROVAL"
  | "COST_DATA_REQUIRED"
  | "PROFIT_RISK_REVIEW"
  | "ACCOUNT_HEALTH_REVIEW"
  | "LISTING_READINESS_REVIEW"
  | "LISTING_SEO_REVIEW"
  | "LISTING_CONVERSION_REVIEW"
  | "PRICING_REVIEW"
  | "INVENTORY_RISK_REVIEW"
  | "LISTING_TITLE_DRAFT_REVIEW"
  | "LISTING_BULLETS_DRAFT_REVIEW"
  | "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW"
  | "LISTING_DESCRIPTION_DRAFT_REVIEW"
  | "PASSPORT_BRAND_POSITIONING_DRAFT_REVIEW"
  | "PASSPORT_CUSTOMER_OBJECTIONS_DRAFT_REVIEW"
  | "PASSPORT_PACKAGE_CONTENTS_DRAFT_REVIEW"
  | "PASSPORT_COMPLIANCE_NOTES_DRAFT_REVIEW"
  | "PASSPORT_USE_CASE_DRAFT_REVIEW"
  | "PASSPORT_TARGET_CUSTOMER_DRAFT_REVIEW"
  | "IMAGE_CREATIVE_REVIEW"
  | "A_PLUS_CONTENT_REVIEW"
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
  | "KEYWORD"
  | "CAMPAIGN"
  | "AD_GROUP"
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
  | "MONITOR"
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
  // Real product photo URL for this row's SKU/ASIN, looked up from Product Passport image
  // data at read time (see getProductImageLookup() in product-passports.service.ts) so
  // Approval Center and AI Actions cards can show a real thumbnail instead of a generic icon.
  // Null when no image is on file for this product yet.
  imageUrl: string | null;
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

export type ActionLedgerBatchUpdateResult = {
  sellerId: string;
  requestedCount: number;
  updatedCount: number;
  skippedCount: number;
  rows: SafeActionLedgerRow[];
  workflowBeforeRows?: ActionLedgerRow[];
};

export type ActionLedgerDailyPriorities = {
  sellerId: string;
  limit: number;
  totalPending: number;
  rows: SafeActionLedgerRow[];
};
