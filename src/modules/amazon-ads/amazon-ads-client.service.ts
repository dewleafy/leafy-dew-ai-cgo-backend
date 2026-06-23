import axios from "axios";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { retry } from "../../utils/retry";
import { AmazonAdsProfile, AmazonAdsRegion } from "./amazon-ads.types";

const AMAZON_ADS_API_ENDPOINTS: Record<AmazonAdsRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com"
};

export async function logAmazonAdsApiCall(input: {
  connectionId?: string;
  endpoint: string;
  method: string;
  statusCode?: number;
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
}): Promise<void> {
  const { error } = await supabase.from("amazon_ads_api_logs").insert({
    connection_id: input.connectionId ?? null,
    endpoint: input.endpoint,
    method: input.method,
    status_code: input.statusCode ?? null,
    success: input.success,
    error_message: input.errorMessage ?? null,
    duration_ms: input.durationMs ?? null
  });

  if (error) {
    logger.warn("Failed to write Amazon Ads API log.", {
      message: error.message,
      endpoint: input.endpoint
    });
  }
}

export async function getAmazonAdsProfiles(
  accessToken: string,
  region: AmazonAdsRegion,
  connectionId?: string
): Promise<AmazonAdsProfile[]> {
  const startedAt = Date.now();
  const endpoint = "/v2/profiles";

  try {
    const response = await retry(() =>
      axios.get<AmazonAdsProfile[]>(`${AMAZON_ADS_API_ENDPOINTS[region]}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? ""
        }
      })
    );

    await logAmazonAdsApiCall({
      connectionId,
      endpoint,
      method: "GET",
      statusCode: response.status,
      success: true,
      durationMs: Date.now() - startedAt
    });

    return response.data;
  } catch (error) {
    const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
    const errorMessage = axios.isAxiosError(error)
      ? error.response?.data?.message ?? error.message
      : "Unknown Amazon Ads API error.";

    await logAmazonAdsApiCall({
      connectionId,
      endpoint,
      method: "GET",
      statusCode,
      success: false,
      errorMessage,
      durationMs: Date.now() - startedAt
    });

    throw new Error(`Amazon Ads Profiles API request failed: ${errorMessage}`);
  }
}
