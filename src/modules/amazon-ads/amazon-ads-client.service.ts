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

export type CampaignStateUpdateOutcome = {
  campaignId: string;
  success: boolean;
  errorMessage?: string;
};

// Writes a real state change (ENABLED/PAUSED) to one or more Sponsored Products
// campaigns. This is the one function in this file that actually changes something
// on Amazon rather than just reading -- used only by the ad dayparting feature, which
// only ever pauses a campaign it itself paused or resumes one it itself paused (see
// amazon-ads-dayparting.service.ts). Every call is logged the same way the read calls
// above are, so a failed or partial update is always visible in amazon_ads_api_logs.
export async function updateSponsoredProductsCampaignStates(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  connectionId: string;
  updates: Array<{ campaignId: string; state: "ENABLED" | "PAUSED" }>;
}): Promise<CampaignStateUpdateOutcome[]> {
  if (input.updates.length === 0) {
    return [];
  }

  const startedAt = Date.now();
  const endpoint = "/sp/campaigns";

  try {
    const response = await retry(() =>
      axios.put<unknown>(
        `${AMAZON_ADS_API_ENDPOINTS[input.region]}${endpoint}`,
        {
          campaigns: input.updates.map((update) => ({
            campaignId: update.campaignId,
            state: update.state
          }))
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

    const outcomes = parseCampaignStateUpdateResponse(input.updates, response.data);
    const failedOutcomes = outcomes.filter((outcome) => !outcome.success);

    // 2026-09-28 diagnostic addition: every failed pause/resume attempt so far has fallen
    // through to the generic "no further detail in the response" message, which means
    // either Amazon truly sends nothing usable, or the real detail lives in a response
    // shape parseCampaignStateUpdateResponse isn't checking yet. Rather than guess, log
    // the FULL raw response body here (sanitized, truncated) so the actual JSON Amazon
    // sent is visible in Railway logs the next time this fails -- this is the only way
    // to tell those two cases apart. Safe to remove once the real failure reason is known.
    if (failedOutcomes.length > 0) {
      let rawResponseDump: string;
      try {
        rawResponseDump = JSON.stringify(response.data);
      } catch {
        rawResponseDump = String(response.data);
      }
      logger.warn("Dayparting campaign update rejected by Amazon - raw response for diagnosis", {
        statusCode: response.status,
        failedCampaignIds: failedOutcomes.map((outcome) => outcome.campaignId),
        rawResponseBody: sanitizeAmazonAdsLogValue(rawResponseDump)?.slice(0, 4000)
      });
    }

    // Amazon can return HTTP 2xx for this endpoint while still rejecting individual
    // campaigns inside the response body -- log the real per-item outcome here instead
    // of a blanket "success: true", so a partial failure is actually visible in
    // amazon_ads_api_logs rather than looking like a clean successful call.
    await logAmazonAdsApiCall({
      connectionId: input.connectionId,
      endpoint,
      method: "PUT",
      statusCode: response.status,
      success: failedOutcomes.length === 0,
      errorMessage: failedOutcomes.length
        ? sanitizeAmazonAdsLogValue(
            failedOutcomes.map((outcome) => `${outcome.campaignId}: ${outcome.errorMessage}`).join(" | ")
          )
        : undefined,
      durationMs: Date.now() - startedAt
    });

    return outcomes;
  } catch (error) {
    const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
    const responseBody = axios.isAxiosError(error) ? error.response?.data : undefined;
    const errorMessage = axios.isAxiosError(error)
      ? (responseBody && typeof responseBody === "object" && "message" in (responseBody as Record<string, unknown>)
          ? String((responseBody as Record<string, unknown>).message)
          : error.message)
      : "Unknown Amazon Ads campaign update error.";

    await logAmazonAdsApiCall({
      connectionId: input.connectionId,
      endpoint,
      method: "PUT",
      statusCode,
      success: false,
      errorMessage: sanitizeAmazonAdsLogValue(String(errorMessage)),
      durationMs: Date.now() - startedAt
    });

    // The whole batch failed at the HTTP level (auth, throttling, malformed request) --
    // report every campaign in this call as failed rather than guessing at a partial result.
    const safeMessage = sanitizeAmazonAdsLogValue(String(errorMessage)) ?? "Unknown error";
    return input.updates.map((update) => ({
      campaignId: update.campaignId,
      success: false,
      errorMessage: safeMessage
    }));
  }
}

// Pulls together whatever fields Amazon actually put on a per-item error entry into one
// readable string. The exact envelope shape isn't documented anywhere reliable, so this
// checks every field name Amazon's v3 endpoints are known to use for the error code and
// the human-readable explanation, rather than assuming one fixed shape.
function describeCampaignUpdateError(entry: Record<string, unknown>): string {
  const firstString = (...values: unknown[]): string | null => {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };

  const code = firstString(entry.code, entry.errorType, entry.errorCode);
  const detail = firstString(entry.details, entry.description, entry.message, entry.errorMessage, entry.reason);

  if (code && detail) return `${code}: ${detail}`;
  if (detail) return detail;
  if (code) return code;
  return "Amazon reported this campaign update as failed (no further detail in the response).";
}

// Amazon's v3 Campaigns API returns per-item success/error results, but the exact
// envelope shape isn't documented anywhere reliable -- this parses defensively across
// the response shapes real Amazon Ads v3 endpoints are known to use, and falls back to
// "assume success" only when the HTTP call itself returned 2xx and no per-item errors
// were found anywhere in the body (a real failure would show up as a non-2xx above).
function parseCampaignStateUpdateResponse(
  updates: Array<{ campaignId: string; state: "ENABLED" | "PAUSED" }>,
  responseData: unknown
): CampaignStateUpdateOutcome[] {
  const body = responseData && typeof responseData === "object" ? (responseData as Record<string, unknown>) : {};
  const campaignsField = body.campaigns;
  const errorEntries: Array<Record<string, unknown>> = [];

  const collectErrors = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          errorEntries.push(entry as Record<string, unknown>);
        }
      }
    }
  };

  if (campaignsField && typeof campaignsField === "object" && !Array.isArray(campaignsField)) {
    collectErrors((campaignsField as Record<string, unknown>).error);
  } else if (Array.isArray(campaignsField)) {
    for (const entry of campaignsField) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const code = record.code ?? (record.success === false ? "ERROR" : undefined);
        if (code) {
          errorEntries.push(record);
        }
      }
    }
  }
  collectErrors(body.error);

  const errorByCampaignId = new Map<string, string>();
  for (const entry of errorEntries) {
    const index = typeof entry.index === "number" ? entry.index : null;
    const campaignId =
      typeof entry.campaignId === "string"
        ? entry.campaignId
        : index !== null && updates[index]
          ? updates[index].campaignId
          : null;
    if (campaignId && !errorByCampaignId.has(campaignId)) {
      const readable = describeCampaignUpdateError(entry);
      errorByCampaignId.set(campaignId, sanitizeAmazonAdsLogValue(readable) ?? readable);
    }
  }

  return updates.map((update) => ({
    campaignId: update.campaignId,
    success: !errorByCampaignId.has(update.campaignId),
    errorMessage: errorByCampaignId.get(update.campaignId)
  }));
}
