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

export type AmazonAdsConfigCheck = {
  adsClientIdPresent: boolean;
  adsClientSecretPresent: boolean;
  adsRedirectUriPresent: boolean;
  adsRedirectUriLooksHttps: boolean;
  adsRegion: AmazonAdsRegion;
};
