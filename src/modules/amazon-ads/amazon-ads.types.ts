export type AmazonAdsRegion = "NA" | "EU" | "FE";

export type AmazonAdsConnectionStatus = "connected" | "disconnected" | "error";

export type AmazonAdsConnection = {
  id: string;
  seller_id: string | null;
  region: AmazonAdsRegion;
  status: AmazonAdsConnectionStatus;
  connected_at: string | null;
  disconnected_at: string | null;
};

export type AmazonAdsOAuthState = {
  sellerId?: string;
  nonce: string;
  region: AmazonAdsRegion;
  createdAt: string;
};

export type AmazonAdsTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
};

export type AmazonAdsProfile = {
  profileId: number;
  countryCode?: string;
  currencyCode?: string;
  timezone?: string;
  accountInfo?: Record<string, unknown>;
};

export type AmazonAdsStoredProfile = {
  profile_id: string;
  country_code: string | null;
  currency_code: string | null;
  timezone: string | null;
  account_info: Record<string, unknown> | null;
};

export type SafeAmazonAdsCampaign = {
  campaignId: string;
  name: string | null;
  campaignType: string | null;
  targetingType: string | null;
  state: string | null;
  status: string | null;
  dailyBudget: number | string | null;
  startDate: string | null;
  endDate: string | null;
};

export type AmazonAdsCampaignWithRaw = SafeAmazonAdsCampaign & {
  rawData: Record<string, unknown>;
};

export type AmazonAdsReportJob = {
  id: string;
  connection_id: string;
  profile_id: string;
  seller_id: string | null;
  report_id: string;
  report_type: string;
  ad_product: string;
  start_date: string;
  end_date: string;
  status: string;
  report_url: string | null;
  failure_reason: string | null;
  requested_at: string | null;
  completed_at: string | null;
};

export type SafeAmazonAdsCampaignDailyMetric = {
  campaignId: string;
  campaignName: string | null;
  reportDate: string;
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  acos: number | null;
  roas: number | null;
  cpc: number | null;
  ctr: number | null;
  conversionRate: number | null;
  lastSyncedAt: string | null;
};

export type SafeAmazonAdsSearchTermDailyMetric = {
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  keywordId: string | null;
  keyword: string | null;
  matchType: string | null;
  targeting: string | null;
  searchTerm: string;
  reportDate: string;
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  acos: number | null;
  roas: number | null;
  cpc: number | null;
  ctr: number | null;
  conversionRate: number | null;
  lastSyncedAt: string | null;
};

// Amazon's "Advertised Product" report (Sponsored Products, reportTypeId
// "spAdvertisedProduct") is the one report type that actually ties ad spend
// to a specific ASIN/SKU, day by day. Neither the campaign report nor the
// search-term report above carries a product dimension at all — this is
// what makes real per-order/per-product ad-spend attribution possible.
export type SafeAmazonAdsAdvertisedProductDailyMetric = {
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  adId: string | null;
  advertisedAsin: string;
  advertisedSku: string | null;
  reportDate: string;
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  acos: number | null;
  roas: number | null;
  cpc: number | null;
  ctr: number | null;
  conversionRate: number | null;
  lastSyncedAt: string | null;
};

export type AmazonAdsSearchTermSummaryRow = {
  searchTerm: string;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  adGroupName: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  ctr: number;
  cpc: number;
  acos: number | null;
  roas: number | null;
  conversionRate: number;
};

export type AmazonAdsSearchTermSummary = {
  totals: AmazonAdsDashboardMetricSummary;
  wastedSearchTerms: AmazonAdsSearchTermSummaryRow[];
  convertingSearchTerms: AmazonAdsSearchTermSummaryRow[];
  highClickNoSaleTerms: AmazonAdsSearchTermSummaryRow[];
  asinSearchTerms: AmazonAdsSearchTermSummaryRow[];
  topSpendTerms: AmazonAdsSearchTermSummaryRow[];
};

export type AmazonAdsDashboardMetricSummary = {
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  ctr: number;
  cpc: number;
  acos: number | null;
  roas: number | null;
  conversionRate: number;
};

export type AmazonAdsDashboardCampaignSummary = AmazonAdsDashboardMetricSummary & {
  campaignId: string;
  campaignName: string | null;
};

export type AmazonAdsDashboardDailyTrend = AmazonAdsDashboardMetricSummary & {
  date: string;
};

export type AmazonAdsDashboardSummary = {
  dateRange: {
    startDate: string;
    endDate: string;
  };
  totals: AmazonAdsDashboardMetricSummary;
  dailyTrend: AmazonAdsDashboardDailyTrend[];
  campaigns: AmazonAdsDashboardCampaignSummary[];
  bestCampaignByClicks: AmazonAdsDashboardCampaignSummary | null;
  highestSpendCampaign: AmazonAdsDashboardCampaignSummary | null;
  zeroSalesSpend: number;
};

export type AmazonAdsConfigCheck = {
  adsClientIdPresent: boolean;
  adsClientSecretPresent: boolean;
  adsRedirectUriPresent: boolean;
  adsRedirectUriLooksHttps: boolean;
  adsRegion: AmazonAdsRegion;
};
