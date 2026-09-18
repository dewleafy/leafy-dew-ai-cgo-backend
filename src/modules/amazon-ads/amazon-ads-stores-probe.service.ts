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
// Amazon's Ads API docs site is a client-rendered SPA that automated fetching cannot read,
// so path names here come from a real, published open-source Amazon Ads API client
// (python-amazon-ad-api), not guesswork:
//   GET /brands              -> list Brand entities (brandId, brandEntityId, brandRegistryName)
//                                tied to the connected profile. This is the real prerequisite
//                                call, separate from listing stores themselves.
//   GET /v2/stores           -> "List store information for all registered stores under an
//                                advertiser" (no brandEntityId needed for this call).
// Both are harmless GETs that cannot change anything in the founder's account.

const AMAZON_ADS_API_ENDPOINTS: Record<AmazonAdsRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com"
};

type AmazonBrand = {
  brandId?: string;
  brandEntityId?: string;
  brandRegistryName?: string;
};

export type AmazonAdsStoresProbeResult = {
  ok: true;
  connected: boolean;
  message: string;
  verdict:
    | "ACCESS_CONFIRMED"
    | "BRAND_LINKED_NO_STORE"
    | "PROFILE_NOT_BRAND_LINKED"
    | "ACCESS_DENIED"
    | "NO_CONNECTION"
    | "UNKNOWN";
  brands: AmazonBrand[];
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
      brands: [],
      details: []
    };
  }

  const accessToken = await getAmazonAdsAccessToken(context.connection.id);
  const host = AMAZON_ADS_API_ENDPOINTS[context.connection.region];
  const details: AmazonAdsStoresProbeResult["details"] = [];
  const baseHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
    "Amazon-Advertising-API-Scope": context.profile.profile_id
  };

  async function callPath(path: string): Promise<{ status: number | null; data: unknown }> {
    try {
      const response = await axios.get(`${host}${path}`, {
        headers: baseHeaders,
        validateStatus: () => true,
        timeout: 15000
      });
      return { status: response.status, data: response.data };
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown network error.";
      logger.warn("Brand Stores API probe request failed.", { sellerId, path, message });
      return { status: null, data: { error: message } };
    }
  }

  // Step 1: does the connected Ads profile see any registered Brand entities at all?
  const brandsResult = await callPath("/brands");
  const brands: AmazonBrand[] = Array.isArray(brandsResult.data) ? (brandsResult.data as AmazonBrand[]) : [];

  details.push({
    path: "/brands",
    httpStatus: brandsResult.status,
    note:
      brandsResult.status === 200
        ? `Found ${brands.length} brand${brands.length === 1 ? "" : "s"} linked to this Ads profile.`
        : brandsResult.status === 403
          ? "Amazon returned Forbidden (403) — this Ads connection cannot see Brand data at all."
          : brandsResult.status === 404
            ? "Amazon returned Not Found (404) for /brands — unexpected for a working Ads connection."
            : `HTTP ${brandsResult.status ?? "request failed"}`
  });

  // Step 2: list stores under the advertiser (does not require a brandEntityId itself).
  const storesResult = await callPath("/v2/stores");
  const storesList = Array.isArray(storesResult.data)
    ? storesResult.data
    : storesResult.data && typeof storesResult.data === "object" && Array.isArray((storesResult.data as { stores?: unknown[] }).stores)
      ? (storesResult.data as { stores: unknown[] }).stores
      : null;

  details.push({
    path: "/v2/stores",
    httpStatus: storesResult.status,
    note:
      storesResult.status === 200
        ? `Amazon returned a successful response${storesList ? ` with ${storesList.length} store${storesList.length === 1 ? "" : "s"}` : ""}.`
        : storesResult.status === 403
          ? "Amazon returned Forbidden (403) — Brand Stores access needs separate enrollment."
          : storesResult.status === 404
            ? "Amazon returned Not Found (404) — either no store is registered for this advertiser, or this profile isn't the one the Brand Store was published under."
            : `HTTP ${storesResult.status ?? "request failed"}`
  });

  let verdict: AmazonAdsStoresProbeResult["verdict"] = "UNKNOWN";
  let message: string;

  if (brandsResult.status === 403 || storesResult.status === 403) {
    verdict = "ACCESS_DENIED";
    message =
      "Amazon returned Forbidden (403). This Ads connection does not have Brand Stores access yet — it needs separate Amazon enrollment beyond the existing Ads API connection.";
  } else if (brandsResult.status === 200 && brands.length === 0) {
    verdict = "PROFILE_NOT_BRAND_LINKED";
    message =
      "The connected Amazon Ads profile does not see any registered Brand entities. Your brands may be registered under Brand Registry, but this specific Ads profile/account (the one this app is connected to) isn't linked to them — likely a different Amazon Ads account or profile owns that link. Check which Ads account you connected this app with against which account manages your Brand Store in Seller Central / Amazon Ads console.";
  } else if (brandsResult.status === 200 && brands.length > 0 && storesResult.status === 200) {
    verdict = "ACCESS_CONFIRMED";
    message = `Good news — this Ads connection sees ${brands.length} registered brand${brands.length === 1 ? "" : "s"} (${brands.map((b) => b.brandRegistryName).filter(Boolean).join(", ") || "unnamed"}) and Amazon returned real store data. Brand Store access already works through this connection.`;
  } else if (brandsResult.status === 200 && brands.length > 0 && storesResult.status === 404) {
    verdict = "BRAND_LINKED_NO_STORE";
    message = `This Ads connection does see ${brands.length} registered brand${brands.length === 1 ? "" : "s"} (${brands.map((b) => b.brandRegistryName).filter(Boolean).join(", ") || "unnamed"}), so Brand Registry access is confirmed working. But Amazon returned Not Found when listing actual stores — most likely no Brand Store page has been published/registered for these brands under this specific Ads profile yet (Brand Registry and a published Store are two separate steps in Amazon's system). Worth checking directly in the Amazon Ads console under Brand Store / Stores whether a store has actually been created and published for each brand.`;
  } else {
    message = "Could not get a conclusive answer from Amazon. See the details below.";
  }

  return {
    ok: true,
    connected: true,
    verdict,
    message,
    brands,
    details
  };
}
