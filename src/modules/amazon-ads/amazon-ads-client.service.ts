import axios from "axios";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { retry } from "../../utils/retry";
import {
  AmazonAdsCampaignWithRaw,
  AmazonAdsProfile,
  AmazonAdsRegion,
  SafeAmazonAdsCampaign
} from "./amazon-ads.types";

const AMAZON_ADS_API_ENDPOINTS: Record<AmazonAdsRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com"
};

type SupabaseErrorDetails = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

function sanitizeAmazonAdsLogValue(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  const secretValues = [
    process.env.AMAZON_ADS_CLIENT_SECRET,
    process.env.AMAZON_ADS_CLIENT_ID,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.ENCRYPTION_KEY
  ].filter((secret): secret is string => Boolean(secret));

  return secretValues.reduce(
    (safeValue, secretValue) => safeValue.replaceAll(secretValue, "[REDACTED]"),
    value
  );
}

function toSafeCampaign(campaign: Record<string, unknown>): SafeAmazonAdsCampaign {
  const campaignId = campaign.campaignId ?? campaign.campaign_id ?? campaign.id;
  const budget =
    campaign.dailyBudget ??
    campaign.daily_budget ??
    (campaign.budget && typeof campaign.budget === "object"
      ? (campaign.budget as Record<string, unknown>).budget
      : null);

  return {
    campaignId: String(campaignId ?? ""),
    name: typeof campaign.name === "string" ? campaign.name : null,
    campaignType: typeof campaign.campaignType === "string" ? campaign.campaignType : "sponsoredProducts",
    targetingType: typeof campaign.targetingType === "string" ? campaign.targetingType : null,
    state: typeof campaign.state === "string" ? campaign.state : typeof campaign.status === "string" ? campaign.status : null,
    status: typeof campaign.status === "string" ? campaign.status : typeof campaign.state === "string" ? campaign.state : null,
    dailyBudget:
      typeof budget === "number" || typeof budget === "string"
        ? budget
        : null,
    startDate: typeof campaign.startDate === "string" ? campaign.startDate : null,
    endDate: typeof campaign.endDate === "string" ? campaign.endDate : null
  };
}

export function logSafeAmazonAdsSupabaseError(context: string, error: SupabaseErrorDetails): void {
  logger.warn(context, {
    message: sanitizeAmazonAdsLogValue(error.message),
    code: sanitizeAmazonAdsLogValue(error.code),
    details: sanitizeAmazonAdsLogValue(error.details),
    hint: sanitizeAmazonAdsLogValue(error.hint)
  });
}

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
    logSafeAmazonAdsSupabaseError("Failed to write Amazon Ads API log.", error);
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

export async function getSponsoredProductsCampaigns(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  connectionId: string;
}): Promise<SafeAmazonAdsCampaign[]> {
  const campaigns = await getSponsoredProductsCampaignsWithRaw(input);

  return campaigns.map(({ rawData: _rawData, ...campaign }) => campaign);
}

export async function getSponsoredProductsCampaignsWithRaw(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  connectionId: string;
}): Promise<AmazonAdsCampaignWithRaw[]> {
  const startedAt = Date.now();
  const endpoint = "/sp/campaigns/list";

  try {
    const response = await retry(() =>
      axios.post<unknown>(
        `${AMAZON_ADS_API_ENDPOINTS[input.region]}${endpoint}`,
        {
          maxResults: 100
        },
        {
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
            "Amazon-Advertising-API-Scope": input.profileId,
            "Content-Type": "application/vnd.spCampaign.v3+json",
            Accept: "application/vnd.spCampaign.v3+json"
          }
        }
      )
    );

    await logAmazonAdsApiCall({
      connectionId: input.connectionId,
      endpoint,
      method: "POST",
      statusCode: response.status,
      success: true,
      durationMs: Date.now() - startedAt
    });

    const responseData = response.data;
    const rawCampaigns = Array.isArray(responseData)
      ? responseData
      : responseData && typeof responseData === "object" && Array.isArray((responseData as Record<string, unknown>).campaigns)
        ? ((responseData as Record<string, unknown>).campaigns as unknown[])
        : [];

    return rawCampaigns
      .filter((campaign): campaign is Record<string, unknown> => Boolean(campaign) && typeof campaign === "object")
      .map((campaign) => ({
        ...toSafeCampaign(campaign),
        rawData: campaign
      }))
      .filter((campaign) => campaign.campaignId.length > 0);
  } catch (error) {
    const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
    const errorMessage = axios.isAxiosError(error)
      ? error.response?.data?.message ?? error.message
      : "Unknown Amazon Ads campaigns API error.";

    await logAmazonAdsApiCall({
      connectionId: input.connectionId,
      endpoint,
      method: "POST",
      statusCode,
      success: false,
      errorMessage: sanitizeAmazonAdsLogValue(String(errorMessage)),
      durationMs: Date.now() - startedAt
    });

    throw new Error(`Amazon Ads campaigns request failed: ${sanitizeAmazonAdsLogValue(String(errorMessage))}`);
  }
}
