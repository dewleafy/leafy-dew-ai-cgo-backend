export type AutomationMode = "SHADOW" | "APPROVAL" | "AUTO_LATER";

export type AutomationSettingsInput = {
  sellerId?: string;
  mode?: AutomationMode;
  maxDailyRecommendations?: number;
  targetAcosDefault?: number;
  minProfitLowPrice?: number;
  minProfitMidPrice?: number;
  allowAutoNegative?: boolean;
  allowAutoBidChange?: boolean;
  allowAutoBudgetChange?: boolean;
  allowAutoKeywordAdd?: boolean;
  allowAutoProductTargetAdd?: boolean;
  allowAutoListingChange?: boolean;
  allowAutoPriceChange?: boolean;
  approvalRequiredForTier2?: boolean;
  approvalRequiredForTier3?: boolean;
  shadowModeDays?: number;
  notes?: string | null;
};

export type AutomationSettingsRow = {
  id: string;
  seller_id: string;
  mode: AutomationMode;
  max_daily_recommendations: number;
  target_acos_default: number | string;
  min_profit_low_price: number | string;
  min_profit_mid_price: number | string;
  allow_auto_negative: boolean;
  allow_auto_bid_change: boolean;
  allow_auto_budget_change: boolean;
  allow_auto_keyword_add: boolean;
  allow_auto_product_target_add: boolean;
  allow_auto_listing_change: boolean;
  allow_auto_price_change: boolean;
  approval_required_for_tier_2: boolean;
  approval_required_for_tier_3: boolean;
  shadow_mode_days: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeAutomationSettings = {
  id: string;
  sellerId: string;
  mode: AutomationMode;
  maxDailyRecommendations: number;
  targetAcosDefault: number;
  minProfitLowPrice: number;
  minProfitMidPrice: number;
  allowAutoNegative: boolean;
  allowAutoBidChange: boolean;
  allowAutoBudgetChange: boolean;
  allowAutoKeywordAdd: boolean;
  allowAutoProductTargetAdd: boolean;
  allowAutoListingChange: boolean;
  allowAutoPriceChange: boolean;
  approvalRequiredForTier2: boolean;
  approvalRequiredForTier3: boolean;
  shadowModeDays: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationSettingsResult = {
  settings: SafeAutomationSettings;
  warnings: string[];
};
