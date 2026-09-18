import axios from "axios";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getAmazonAdsAccessToken } from "./amazon-ads-token.service";
import { getFirstAmazonAdsProfile } from "./amazon-ads-profile.service";
import { AmazonAdsConnection, AmazonAdsRegion, AmazonAdsStoredProfile } from "./amazon-ads.types";

// Read-only diagnostic: does the founder's EXISTING Amazon Ads API access (the
// "advertising::campaign_management" OAuth scope this app already has) also cover the
// newer Brand Stores API, or does that require separate Amazon enrollment?
//
// There is no safe way to answer this from documentation (Amazon's Ads API docs site is a
// client-rendered SPA that automated fetching cannot read), so this makes one real, harmless
// GET request to Amazon's Stores API using the founder's real, already-connected credentials
// and reports back what Amazon's own server says. A GET to a listing endpoint cannot change
// anything in the founder's account.

const AMAZON_ADS_API_ENDPOINTS: Record<AmazonAdsRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com"
};

// Amazon's Stores API has changed paths as it moved out of beta; try the current
// documented-in-the-wild path first, then a legacy fallback, so one wrong guess doesn't
// produce a misleading "no access" verdict.
const CANDIDATE_PATHS = ["/stores/v1/brands", "/v2/stores"];

export type AmazonAdsStoresProbeResult = {
  ok: true;
  connected: boolean;
  message: string;
  verdict: "ACCESS_CONFIRMED" | "ACCESS_DENIED" | "NOT_FOUND" | "NO_CONNECTION" | "UNKNOWN";
  details: Array<{
    path: string;
    httpStatus: number | null;
    note: string;
  }>;
};

async function loadAmazonAdsProbeContext(sellerId: string): Promise<
  | { ok: true; connection: AmazonAdsConnection; profile: AmazonAdsStoredProfile }
  | { ok: false; message: string }
> {
  let query = supabase
    .from("amazon_ads_connections")
    .select("*")
    .eq("status", "connected")
    .order("connected_at", { ascending: false })
    .limit(1);

  if (sellerId !== "default") {
    query = query.eq("seller_id", sellerId);
  }

  const { data: connection, error } = await query.maybeSingle<AmazonAdsConnection>();

  if (error) {
    return { ok: false, message: "Could not load your Amazon Ads connection from Supabase." };
  }

  if (!connection) {
    return { ok: false, message: "No connected Amazon Ads account found. Connect Amazon Ads first." };
  }

  const profile = await getFirstAmazonAdsProfile(connection.id);

  if (!profile) {
    return { ok: false, message: "No Amazon Ads profile found. Reconnect Amazon Ads to sync profiles." };
  }

  return { ok: true, connection, profile };
}

export async function probeBrandStoresApiAccess(sellerId: string): Promise<AmazonAdsStoresProbeResult> {
  const context = await loadAmazonAdsProbeContext(sellerId);

  if (!context.ok) {
    return {
      ok: true,
      connected: false,
      verdict: "NO_CONNECTION",
      message: context.message,
      details: []
    };
  }

  const accessToken = await getAmazonAdsAccessToken(context.connection.id);
  const host = AMAZON_ADS_API_ENDPOINTS[context.connection.region];
  const details: AmazonAdsStoresProbeResult["details"] = [];

  let bestVerdict: AmazonAdsStoresProbeResult["verdict"] = "UNKNOWN";

  for (const path of CANDIDATE_PATHS) {
    try {
      const response = await axios.get(`${host}${path}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
          "Amazon-Advertising-API-Scope": context.profile.profile_id
        },
        validateStatus: () => true,
        timeout: 15000
      });

      const status = response.status;
      let note = `HTTP ${status}`;

      if (status === 200) {
        note = "Amazon returned a successful response — existing Ads API access already covers this.";
        bestVerdict = "ACCESS_CONFIRMED";
      } else if (status === 401) {
        note = "Amazon rejected the access token itself (401) — likely an unrelated auth problem, not a scope issue.";
        if (bestVerdict === "UNKNOWN") bestVerdict = "UNKNOWN";
      } else if (status === 403) {
        note = "Amazon returned Forbidden (403) — the existing Ads API access/scope does not cover Brand Stores; separate enrollment is required.";
        if (bestVerdict === "UNKNOWN") bestVerdict = "ACCESS_DENIED";
      } else if (status === 404) {
        note = "Amazon returned Not Found (404) for this path — either the wrong endpoint path or no store exists yet.";
        if (bestVerdict === "UNKNOWN") bestVerdict = "NOT_FOUND";
      } else if (status === 400) {
        note = "Amazon returned Bad Request (400) — the endpoint exists and accepted the credentials, but needs different parameters.";
        bestVerdict = "ACCESS_CONFIRMED";
      }

      details.push({ path, httpStatus: status, note });
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown network error.";
      details.push({ path, httpStatus: null, note: `Request failed: ${message}` });
      logger.warn("Brand Stores API probe request failed.", { sellerId, path, message });
    }
  }

  const verdictMessage =
    bestVerdict === "ACCESS_CONFIRMED"
      ? "Good news — your existing Amazon Ads connection already has access to the Brand Stores API. No separate enrollment needed."
      : bestVerdict === "ACCESS_DENIED"
        ? "Your existing Amazon Ads connection does NOT have access to the Brand Stores API yet. Amazon requires separate enrollment (their own Ads API onboarding process) before this app could read or manage your Brand Store."
        : bestVerdict === "NOT_FOUND"
          ? "Amazon accepted the credentials but returned Not Found for the Brand Stores endpoints tried. This usually means the exact API path has changed again, not that access is blocked — treat this as inconclusive."
          : "Could not get a conclusive answer from Amazon. See the details below.";

  return {
    ok: true,
    connected: true,
    verdict: bestVerdict,
    message: verdictMessage,
    details
  };
}
