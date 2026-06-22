import axios from "axios";
import crypto from "crypto";
import { env } from "../../config/env";
import { createSignedState, verifySignedState } from "../../utils/encryption";
import { AmazonRegion, LwaTokenResponse, OAuthState } from "./amazon.types";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function buildAmazonConnectUrl(sellerId: string, region: AmazonRegion = env.AMAZON_SP_API_REGION) {
  const state = createSignedState({
    sellerId,
    region,
    nonce: crypto.randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString()
  } satisfies OAuthState);

  const url = new URL("/apps/authorize/consent", env.AMAZON_AUTH_BASE_URL);
  // TODO: Use the real Amazon SP-API application ID from Seller Central.
  url.searchParams.set("application_id", env.AMAZON_APP_ID);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${env.APP_BASE_URL}/api/amazon/callback`);

  return {
    url: url.toString(),
    state
  };
}

export function parseAndValidateOAuthState(state: string): OAuthState {
  const parsed = verifySignedState<OAuthState>(state);
  const createdAt = new Date(parsed.createdAt).getTime();

  if (!parsed.sellerId || !parsed.region || !createdAt) {
    throw new Error("OAuth state is missing required fields.");
  }

  if (Date.now() - createdAt > STATE_MAX_AGE_MS) {
    throw new Error("OAuth state has expired. Please restart Amazon connection.");
  }

  return parsed;
}

export async function exchangeAuthorizationCode(code: string): Promise<LwaTokenResponse> {
  // TODO: Real Amazon LWA client ID and secret must exist in .env before this can work.
  const response = await axios.post<LwaTokenResponse>(
    env.AMAZON_LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.APP_BASE_URL}/api/amazon/callback`,
      client_id: env.AMAZON_LWA_CLIENT_ID,
      client_secret: env.AMAZON_LWA_CLIENT_SECRET
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data;
}

export async function refreshAccessToken(refreshToken: string): Promise<LwaTokenResponse> {
  const response = await axios.post<LwaTokenResponse>(
    env.AMAZON_LWA_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.AMAZON_LWA_CLIENT_ID,
      client_secret: env.AMAZON_LWA_CLIENT_SECRET
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data;
}
