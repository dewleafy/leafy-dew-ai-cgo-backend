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
    | "SPONSORED_BRANDS_NOT_ENABLED"
    | "STORES_SPECIFIC_BLOCK"
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

  // Sponsored Brands campaigns list (POST is Amazon's pattern for this "list/search" call,
  // not a mutation — an empty body just means "return everything"). This tells us whether the
  // Sponsored Brands product itself is enabled for this profile at all, since Amazon's own
  // Stores API lives under the Sponsored Brands product family alongside campaigns.
  async function callSponsoredBrandsCampaignsList(): Promise<{ status: number | null; data: unknown }> {
    try {
      const response = await axios.post(
        `${host}/sb/v4/campaigns/list`,
        {},
        {
          headers: { ...baseHeaders, Accept: "application/vnd.sbcampaignresource.v4+json" },
          validateStatus: () => true,
          timeout: 15000
        }
      );
      return { status: response.status, data: response.data };
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown network error.";
      logger.warn("Sponsored Brands campaigns probe request failed.", { sellerId, message });
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

  // Only bother checking Sponsored Brands enablement if the simple explanations (no brand
  // link, outright 403) don't already answer it — this call costs a real API round trip.
  let sbCampaignsResult: { status: number | null; data: unknown } | null = null;

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
    // Brand Registry is confirmed linked, but the "list all stores" call still says Not Found.
    // If the founder has confirmed the Store pages are actually live, this 404 is not about
    // whether a Store exists — check whether Sponsored Brands (the product family this
    // endpoint lives under) is enabled at all for this profile, which narrows it further.
    sbCampaignsResult = await callSponsoredBrandsCampaignsList();

    details.push({
      path: "/sb/v4/campaigns/list",
      httpStatus: sbCampaignsResult.status,
      note:
        sbCampaignsResult.status === 200
          ? "Sponsored Brands campaigns are reachable through this profile — Sponsored Brands itself is enabled."
          : sbCampaignsResult.status === 403 || sbCampaignsResult.status === 404
            ? `Amazon returned ${sbCampaignsResult.status} for Sponsored Brands campaigns too — Sponsored Brands does not appear enabled for this profile.`
            : `HTTP ${sbCampaignsResult.status ?? "request failed"}`
    });

    if (sbCampaignsResult.status === 200) {
      verdict = "STORES_SPECIFIC_BLOCK";
      message = `This Ads connection sees ${brands.length} registered brand${brands.length === 1 ? "" : "s"} (${brands.map((b) => b.brandRegistryName).filter(Boolean).join(", ") || "unnamed"}), and Sponsored Brands campaigns work fine through this same profile — so the product family isn't disabled. Yet the Stores "list all" endpoint still returns Not Found. Since you've confirmed both Store pages are actually live on Amazon, this points to the Stores API listing endpoint itself being restricted or requiring a separate access grant beyond standard Sponsored Brands access — this is the kind of thing that needs an Amazon Ads API support case (via the Advertising API developer console) referencing brandEntityIds ${brands.map((b) => b.brandEntityId).filter(Boolean).join(", ")}, since no public documentation covers this gap.`;
    } else {
      verdict = "SPONSORED_BRANDS_NOT_ENABLED";
      message = `This Ads connection sees ${brands.length} registered brand${brands.length === 1 ? "" : "s"} (${brands.map((b) => b.brandRegistryName).filter(Boolean).join(", ") || "unnamed"}) — Brand Registry linkage works. But Sponsored Brands campaigns ALSO return Not Found/Forbidden through this same profile, not just Stores. This strongly suggests the Sponsored Brands advertising product itself has never been activated for this Ads account (this app has so far only ever used Sponsored Products), and the Stores API lives under that same product family. Even though your Store pages are live on Amazon (published through Brand Registry / Store Builder, which is separate from the Ads product), the Ads API can't see them until Sponsored Brands is enabled for this advertiser account. Check Seller Central / Amazon Ads console for a "Sponsored Brands" or "enable this campaign type" prompt on this account.`;
    }
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
