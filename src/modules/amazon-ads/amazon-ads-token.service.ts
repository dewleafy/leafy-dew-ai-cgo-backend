import { supabase } from "../../db/supabase";
import { decryptText, encryptText } from "../../utils/encryption";
import { AmazonAdsTokenResponse } from "./amazon-ads.types";
import { refreshAmazonAdsAccessToken } from "./amazon-ads-auth.service";

type AmazonAdsTokenRow = {
  encrypted_refresh_token: string;
};

export async function saveAmazonAdsRefreshToken(
  connectionId: string,
  tokenResponse: AmazonAdsTokenResponse
): Promise<void> {
  if (!tokenResponse.refresh_token) {
    throw new Error("Amazon Ads did not return a refresh token. Please reconnect the account.");
  }

  const { error } = await supabase.from("amazon_ads_tokens").upsert(
    {
      connection_id: connectionId,
      encrypted_refresh_token: encryptText(tokenResponse.refresh_token),
      token_type: tokenResponse.token_type,
      scopes: ["advertising::campaign_management"],
      updated_at: new Date().toISOString()
    },
    { onConflict: "connection_id" }
  );

  if (error) {
    throw new Error(`Could not save Amazon Ads token: ${error.message}`);
  }
}

export async function getAmazonAdsAccessToken(connectionId: string): Promise<string> {
  const { data, error } = await supabase
    .from("amazon_ads_tokens")
    .select("encrypted_refresh_token")
    .eq("connection_id", connectionId)
    .single<AmazonAdsTokenRow>();

  if (error || !data) {
    throw new Error("No Amazon Ads token found. Please reconnect Amazon Ads.");
  }

  const refreshToken = decryptText(data.encrypted_refresh_token);
  const refreshed = await refreshAmazonAdsAccessToken(refreshToken);

  return refreshed.access_token;
}

export async function deleteAmazonAdsTokens(connectionId: string): Promise<void> {
  const { error } = await supabase.from("amazon_ads_tokens").delete().eq("connection_id", connectionId);

  if (error) {
    throw new Error(`Could not delete Amazon Ads token: ${error.message}`);
  }
}
