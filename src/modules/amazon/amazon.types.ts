export type AmazonRegion = "NA" | "EU" | "FE";

export type AmazonConnectionStatus = "connected" | "disconnected" | "error";

export type AmazonConnection = {
  id: string;
  seller_id: string;
  amazon_seller_id: string | null;
  region: AmazonRegion;
  status: AmazonConnectionStatus;
  connected_at: string | null;
  disconnected_at: string | null;
};

export type AmazonMarketplace = {
  marketplace_id: string;
  name: string;
  country_code: string;
  default_currency_code?: string;
  default_language_code?: string;
};

export type LwaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
};

export type OAuthState = {
  sellerId: string;
  region: AmazonRegion;
  nonce: string;
  createdAt: string;
};

export type MarketplaceParticipation = {
  marketplace: {
    id: string;
    name: string;
    countryCode: string;
    defaultCurrencyCode?: string;
    defaultLanguageCode?: string;
  };
  participation?: {
    isParticipating?: boolean;
    hasSuspendedListings?: boolean;
  };
};
