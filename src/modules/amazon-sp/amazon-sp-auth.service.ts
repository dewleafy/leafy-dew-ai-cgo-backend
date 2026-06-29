import axios from "axios";
import crypto from "crypto";
import { env } from "../../config/env";
import { createSignedState, verifySignedState } from "../../utils/encryption";
import { AmazonSpOAuthState, AmazonSpRegion, AmazonSpTokenResponse } from "./amazon-sp.types";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const SELLER_CENTRAL_AUTH_BASE: Record<AmazonSpRegion, string> = {
  NA: "https://sellercentral.amazon.com",
  EU: "https://sellercentral-europe.amazon.com",
  FE: "https://sellercentral.amazon.in"
};

export function getAmazonSpRegion(): AmazonSpRegion {
  return env.SP_API_REGION ?? env.AMAZON_SP_API_REGION ?? "FE";
}

export function getAmazonSpMarketplaceId(): string {
  return env.SP_API_MARKETPLACE_ID || "A21TJRUUN4KGV";
}

function getAmazonSpClientId(): string | undefined {
  return env.SP_API_LWA_CLIENT_ID ?? env.AMAZON_LWA_CLIENT_ID ?? env.AMAZON_ADS_CLIENT_ID;
}

function getAmazonSpClientSecret(): string | undefined {
  return env.SP_API_LWA_CLIENT_SECRET ?? env.AMAZON_LWA_CLIENT_SECRET ?? env.AMAZON_ADS_CLIENT_SECRET;
}

function getAmazonSpApplicationId(): string | undefined {
  return env.SP_API_APPLICATION_ID ?? env.AMAZON_APP_ID;
}

function getAmazonSpRedirectUri(): string | undefined {
  if (env.SP_API_REDIRECT_URI) {
    return env.SP_API_REDIRECT_URI;
  }

  return new URL("/api/amazon-sp/callback", env.APP_BASE_URL).toString();
}

export function getAmazonSpEndpoint(region: AmazonSpRegion = getAmazonSpRegion()): string {
  if (region === "NA") return "https://sellingpartnerapi-na.amazon.com";
  if (region === "EU") return "https://sellingpartnerapi-eu.amazon.com";
  return "https://sellingpartnerapi-fe.amazon.com";
}

export function getAmazonSpConfigCheck() {
  return {
    ok: true,
    hasClientId: Boolean(getAmazonSpClientId()),
    hasClientSecret: Boolean(getAmazonSpClientSecret()),
    hasApplicationId: Boolean(getAmazonSpApplicationId()),
    hasMarketplaceId: Boolean(getAmazonSpMarketplaceId()),
    hasRedirectUri: Boolean(getAmazonSpRedirectUri()),
    hasEncryptionKey: Boolean(env.SP_API_TOKEN_ENCRYPTION_KEY || env.ENCRYPTION_KEY),
    region: getAmazonSpRegion(),
    marketplaceId: getAmazonSpMarketplaceId()
  };
}

export function assertAmazonSpOAuthConfig(): void {
  const missing: string[] = [];
  if (!getAmazonSpClientId()) missing.push("SP_API_LWA_CLIENT_ID or AMAZON_LWA_CLIENT_ID");
  if (!getAmazonSpClientSecret()) missing.push("SP_API_LWA_CLIENT_SECRET or AMAZON_LWA_CLIENT_SECRET");
  if (!getAmazonSpApplicationId()) missing.push("SP_API_APPLICATION_ID or AMAZON_APP_ID");
  if (!getAmazonSpRedirectUri()) missing.push("SP_API_REDIRECT_URI or APP_BASE_URL");
  if (missing.length > 0) {
    throw new Error(`Missing Amazon SP-API environment variables: ${missing.join(", ")}`);
  }
}

export function buildAmazonSpConnectUrl(sellerId: string): { connectUrl: string; state: string } {
  assertAmazonSpOAuthConfig();

  const state = createSignedState({
    sellerId,
    nonce: crypto.randomBytes(16).toString("hex"),
    marketplaceId: getAmazonSpMarketplaceId(),
    region: getAmazonSpRegion(),
    createdAt: new Date().toISOString()
  } satisfies AmazonSpOAuthState);

  const url = new URL("/apps/authorize/consent", SELLER_CENTRAL_AUTH_BASE[getAmazonSpRegion()]);
  url.searchParams.set("application_id", getAmazonSpApplicationId() as string);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", getAmazonSpRedirectUri() as string);

  return {
    connectUrl: url.toString(),
    state
  };
}

export function parseAmazonSpState(state: string): AmazonSpOAuthState {
  const parsed = verifySignedState<AmazonSpOAuthState>(state);
  const createdAt = new Date(parsed.createdAt).getTime();

  if (!parsed.nonce || !parsed.region || !parsed.marketplaceId || !createdAt) {
    throw new Error("Amazon SP-API OAuth state is missing required fields.");
  }

  if (Date.now() - createdAt > STATE_MAX_AGE_MS) {
    throw new Error("Amazon SP-API OAuth state has expired. Please restart connection.");
  }

  return parsed;
}

export async function exchangeAmazonSpAuthorizationCode(code: string): Promise<AmazonSpTokenResponse> {
  assertAmazonSpOAuthConfig();

  const response = await axios.post<AmazonSpTokenResponse>(
    env.AMAZON_LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: getAmazonSpClientId() as string,
      client_secret: getAmazonSpClientSecret() as string,
      redirect_uri: getAmazonSpRedirectUri() as string
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data;
}

export async function refreshAmazonSpAccessToken(refreshToken: string): Promise<AmazonSpTokenResponse> {
  assertAmazonSpOAuthConfig();

  const response = await axios.post<AmazonSpTokenResponse>(
    env.AMAZON_LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getAmazonSpClientId() as string,
      client_secret: getAmazonSpClientSecret() as string
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data;
}
