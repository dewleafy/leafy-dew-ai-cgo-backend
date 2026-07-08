export type EngineCategory =
  | "DATA_QUALITY"
  | "PRODUCT_ECONOMICS"
  | "PPC"
  | "LISTING_SEO"
  | "LISTING_CONVERSION"
  | "INVENTORY"
  | "PRICING"
  | "ACCOUNT_HEALTH"
  | "RETURNS_REVIEWS"
  | "COMPETITOR_INTELLIGENCE"
  | "SEASONALITY"
  | "CONTENT_A_PLUS"
  | "IMAGE_CREATIVE"
  | "BRAND_STORE"
  | "SOCIAL_CONTENT";

export type EngineRuleTemplate =
  | "MISSING_DATA_CHECK"
  | "PROFIT_GUARDRAIL_CHECK"
  | "ACOS_GUARDRAIL_CHECK"
  | "ROAS_OPPORTUNITY_CHECK"
  | "KEYWORD_OPPORTUNITY_CHECK"
  | "NEGATIVE_KEYWORD_REVIEW"
  | "LISTING_READINESS_CHECK"
  | "LISTING_SEO_GAP_CHECK"
  | "CONVERSION_RISK_CHECK"
  | "INVENTORY_RISK_CHECK"
  | "PRICING_RISK_CHECK"
  | "ACCOUNT_HEALTH_CHECK"
  | "RETURN_REVIEW_RISK_CHECK"
  | "COMPETITOR_GAP_CHECK"
  | "SEASONAL_OPPORTUNITY_CHECK"
  | "CONTENT_GAP_CHECK"
  | "IMAGE_GAP_CHECK"
  | "BRAND_STORE_GAP_CHECK"
  | "SOCIAL_CALENDAR_CHECK"
  | "GENERIC_REVIEW";

export type EngineRiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type EngineCostLevel = "LOW" | "MEDIUM";
export type EngineRunFrequency = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export type EngineDefinition = {
  engineKey: string;
  engineName: string;
  category: EngineCategory;
  subcategory: string;
  description: string;
  inputRequirements: string[];
  dataSources: string[];
  ruleTemplate: EngineRuleTemplate;
  ruleConfig: Record<string, unknown>;
  outputActionType: string;
  outputEntityType: string | null;
  riskLevel: EngineRiskLevel;
  costLevel: EngineCostLevel;
  priorityScore: number;
  runFrequency: EngineRunFrequency;
  enabled: boolean;
  shadowMode: boolean;
  requiresApproval: boolean;
  ownerModule: string;
  version: "v1";
};

export type EngineRegistryRow = {
  id: string;
  engine_key: string;
  engine_name: string;
  category: EngineCategory | string;
  subcategory: string | null;
  description: string | null;
  input_requirements: unknown[] | null;
  data_sources: unknown[] | null;
  rule_template: EngineRuleTemplate | string;
  rule_config: Record<string, unknown> | null;
  output_action_type: string;
  output_entity_type: string | null;
  risk_level: EngineRiskLevel | string;
  cost_level: EngineCostLevel | string;
  priority_score: number | string;
  run_frequency: EngineRunFrequency | string;
  enabled: boolean;
  shadow_mode: boolean;
  requires_approval: boolean;
  owner_module: string | null;
  version: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type EngineRunLogRow = {
  id: string;
  engine_key: string;
  seller_id: string;
  run_status: string;
  run_type: string;
  input_snapshot: Record<string, unknown> | null;
  output_snapshot: Record<string, unknown> | null;
  actions_created_count: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  metadata: Record<string, unknown> | null;
};

export type SafeEngineRegistryRow = {
  id: string;
  engineKey: string;
  engineName: string;
  category: string;
  subcategory: string | null;
  description: string | null;
  inputRequirements: unknown[];
  dataSources: unknown[];
  ruleTemplate: string;
  ruleConfig: Record<string, unknown>;
  outputActionType: string;
  outputEntityType: string | null;
  riskLevel: string;
  costLevel: string;
  priorityScore: number;
  runFrequency: string;
  enabled: boolean;
  shadowMode: boolean;
  requiresApproval: boolean;
  ownerModule: string | null;
  version: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SafeEngineRunLogRow = {
  id: string;
  engineKey: string;
  sellerId: string;
  runStatus: string;
  runType: string;
  inputSnapshot: Record<string, unknown> | null;
  outputSnapshot: Record<string, unknown> | null;
  actionsCreatedCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, unknown>;
};

export type EngineRegistrySummary = {
  ok: true;
  totalEngines: number;
  enabledCount: number;
  disabledCount: number;
  shadowModeCount: number;
  requiresApprovalCount: number;
  categoryCounts: Record<string, number>;
  riskCounts: Record<string, number>;
  costLevelCounts: Record<string, number>;
  highRiskCount: number;
  lastRunFailureCount: number;
};

export type EngineSeedResult = {
  createdCount: number;
  updatedCount: number;
  totalSeeded: number;
  categoryCounts: Record<string, number>;
};

export type EngineRegistryListFilters = {
  category?: string;
  subcategory?: string;
  enabled?: boolean;
  limit: number;
};
