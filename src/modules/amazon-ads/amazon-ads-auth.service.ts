import axios from "axios";
import crypto from "crypto";
import { env } from "../../config/env";
import { createSignedState, verifySignedState } from "../../utils/encryption";
import {
  AmazonAdsConfigCheck,
  AmazonAdsOAuthState,
  AmazonAdsRegion,
  AmazonAdsTokenResponse
} from "./amazon-ads.types";

const AMAZON_ADS_AUTH_URL = "https://www.amazon.com/ap/oa";
const AMAZON_ADS_SCOPE = "advertising::campaign_management";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function getAmazonAdsConfigCheck(): AmazonAdsConfigCheck {
  return {
    adsClientIdPresent: Boolean(env.AMAZON_ADS_CLIENT_ID),
    adsClientSecretPresent: Boolean(env.AMAZON_ADS_CLIENT_SECRET),
    adsRedirectUriPresent: Boolean(env.AMAZON_ADS_REDIRECT_URI),
    adsRedirectUriLooksHttps: Boolean(
      env.AMAZON_ADS_REDIRECT_URI && URL.canParse(env.AMAZON_ADS_REDIRECT_URI)
        ? new URL(env.AMAZON_ADS_REDIRECT_URI).protocol === "https:"
        : false
    ),
    adsRegion: env.AMAZON_ADS_REGION
  };
}

export function assertAmazonAdsConfig(): void {
  const missing: string[] = [];

  if (!env.AMAZON_ADS_CLIENT_ID) {
    missing.push("AMAZON_ADS_CLIENT_ID");
  }

  if (!env.AMAZON_ADS_CLIENT_SECRET) {
    missing.push("AMAZON_ADS_CLIENT_SECRET");
  }

  if (!env.AMAZON_ADS_REDIRECT_URI) {
    missing.push("AMAZON_ADS_REDIRECT_URI");
  }

  if (missing.length > 0) {
    throw new Error(`Missing Amazon Ads environment variables: ${missing.join(", ")}`);
  }
}

export function buildAmazonAdsConnectUrl(sellerId?: string): { authorizationUrl: string; state: string } {
  assertAmazonAdsConfig();

  const state = createSignedState({
    sellerId,
    nonce: crypto.randomBytes(16).toString("hex"),
    region: env.AMAZON_ADS_REGION,
    createdAt: new Date().toISOString()
  } satisfies AmazonAdsOAuthState);

  const url = new URL(AMAZON_ADS_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.AMAZON_ADS_CLIENT_ID as string);
  url.searchParams.set("scope", AMAZON_ADS_SCOPE);
  url.searchParams.set("redirect_uri", env.AMAZON_ADS_REDIRECT_URI as string);
  url.searchParams.set("state", state);

  return {
    authorizationUrl: url.toString(),
    state
  };
}

export function parseAmazonAdsState(state: string): AmazonAdsOAuthState {
  const parsed = verifySignedState<AmazonAdsOAuthState>(state);
  const createdAt = new Date(parsed.createdAt).getTime();

  if (!parsed.nonce || !parsed.region || !createdAt) {
    throw new Error("Amazon Ads OAuth state is missing required fields.");
  }

  if (Date.now() - createdAt > STATE_MAX_AGE_MS) {
    throw new Error("Amazon Ads OAuth state has expired. Please restart connection.");
  }

  return parsed;
}

export async function exchangeAmazonAdsAuthorizationCode(code: string): Promise<AmazonAdsTokenResponse> {
  assertAmazonAdsConfig();

  const response = await axios.post<AmazonAdsTokenResponse>(
    env.AMAZON_LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.AMAZON_ADS_CLIENT_ID as string,
      client_secret: env.AMAZON_ADS_CLIENT_SECRET as string,
      redirect_uri: env.AMAZON_ADS_REDIRECT_URI as string
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data;
}

export async function refreshAmazonAdsAccessToken(refreshToken: string): Promise<AmazonAdsTokenResponse> {
  assertAmazonAdsConfig();

  const response = await axios.post<AmazonAdsTokenResponse>(
    env.AMAZON_LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.AMAZON_ADS_CLIENT_ID as string,
      client_secret: env.AMAZON_ADS_CLIENT_SECRET as string
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data;
}
