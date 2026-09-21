import axios from "axios";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getAmazonAdsAccessToken } from "./amazon-ads-token.service";
import { getFirstAmazonAdsProfile } from "./amazon-ads-profile.service";
import { AmazonAdsConnection, AmazonAdsRegion, AmazonAdsStoredProfile } from "./amazon-ads.types";

// Read-only diagnostic: does the founder's EXISTING Amazon Ads API access (the
// "advertising::campaign_management" OAuth scope this app already has) also cover the
// Brand Stores API, and can this connection actually pull real Store data back?
//
// History: the original version of this probe called `GET /v2/stores`, which consistently
// returned 404 even though Brand Registry linkage (/brands) and Sponsored Brands
// (/sb/v4/campaigns/list) both worked. Amazon's own Ads API support team confirmed by email
// (2026-09-22, case referencing brandEntityIds ENTITY1MRD6TIID97OP / ENTITY3KKYH518R0DHF):
// `GET /v2/stores` was permanently deprecated and shut off on 2026-06-01 -- it wasn't an
// access/enrollment gap, the endpoint itself no longer exists for anyone. The real, current
// replacement is `POST /brand/stores/v1/storePages/list`.
//
// The wrinkle Amazon support flagged: storePages/list needs the STORE's own entity ID
// (identifierType: ENTITY_ID), which is not always the same as the brandEntityId returned by
// GET /brands. This account is a SELLER profile (not vendor), so per Amazon support's own
// instructions, a seller-profile Store has its own separate sub-entity ID that must be looked
// up first via `POST /brand/stores/v1/stores/list`. Amazon support's documented request shape
// for both endpoints is `{ "identifier": "<ENTITY_ID value>", "identifierType": "ENTITY_ID" }`.
//
// What "identifier" to pass into that first lookup call is the one detail Amazon's email
// didn't fully pin down for a multi-brand seller account (they said "your profile's advertiser
// entityId", which is a value this app has never had a confirmed source for). Rather than
// guess at a single value and risk another silent wrong-endpoint dead end, this probe tries
// every real, already-known ENTITY_ID-shaped candidate empirically (each brand's own
// brandEntityId from /brands, since those are confirmed real ENTITY_ID values for this
// account) and records Amazon's actual raw response for each -- so whichever one works (or the
// real error Amazon returns for each) becomes concrete evidence, not another guess.
//
// All calls here are read-only list/lookup calls and cannot change anything in the founder's
// account.

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

type ProbeCallDetail = {
  path: string;
  method: "GET" | "POST";
  requestBody?: Record<string, unknown>;
  httpStatus: number | null;
  note: string;
};

type DiscoveredStore = {
  fromCandidateLabel: string;
  fromCandidateIdentifier: string;
  storeEntityId: string;
  raw: Record<string, unknown>;
};

export type AmazonAdsStoresProbeResult = {
  ok: true;
  connected: boolean;
  message: string;
  verdict:
    | "ACCESS_CONFIRMED"
    | "STORE_ID_FOUND_PAGES_BLOCKED"
    | "STORES_LIST_NEEDS_FOLLOWUP"
    | "SPONSORED_BRANDS_NOT_ENABLED"
    | "BRAND_LINKED_NO_STORE"
    | "PROFILE_NOT_BRAND_LINKED"
    | "ACCESS_DENIED"
    | "NO_CONNECTION"
    | "UNKNOWN";
  brands: AmazonBrand[];
  discoveredStores: DiscoveredStore[];
  storePages: Array<{ storeEntityId: string; httpStatus: number | null; pageCount: number | null; raw: unknown }>;
  details: ProbeCallDetail[];
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

function extractEntityIdCandidates(source: unknown, seen: Set<string>): string[] {
  const found: string[] = [];

  function walk(value: unknown): void {
    if (!value) return;
    if (typeof value === "string" && /^ENTITY[A-Z0-9]{6,}$/i.test(value) && !seen.has(value)) {
      seen.add(value);
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  }

  walk(source);
  return found;
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
      discoveredStores: [],
      storePages: [],
      details: []
    };
  }

  const accessToken = await getAmazonAdsAccessToken(context.connection.id);
  const host = AMAZON_ADS_API_ENDPOINTS[context.connection.region];
  const details: ProbeCallDetail[] = [];
  const baseHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
    "Amazon-Advertising-API-Scope": context.profile.profile_id
  };

  async function callGet(path: string): Promise<{ status: number | null; data: unknown }> {
    try {
      const response = await axios.get(`${host}${path}`, {
        headers: baseHeaders,
        validateStatus: () => true,
        timeout: 15000
      });
      return { status: response.status, data: response.data };
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.message : error instanceof Error ? error.message : "Unknown network error.";
      logger.warn("Brand Stores API probe GET failed.", { sellerId, path, message });
      return { status: null, data: { error: message } };
    }
  }

  async function callPost(path: string, body: Record<string, unknown>, acceptHeader?: string): Promise<{ status: number | null; data: unknown }> {
    try {
      const response = await axios.post(`${host}${path}`, body, {
        headers: acceptHeader ? { ...baseHeaders, Accept: acceptHeader } : baseHeaders,
        validateStatus: () => true,
        timeout: 15000
      });
      return { status: response.status, data: response.data };
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.message : error instanceof Error ? error.message : "Unknown network error.";
      logger.warn("Brand Stores API probe POST failed.", { sellerId, path, message });
      return { status: null, data: { error: message } };
    }
  }

  // Step 1: does the connected Ads profile see any registered Brand entities at all?
  const brandsResult = await callGet("/brands");
  const brands: AmazonBrand[] = Array.isArray(brandsResult.data) ? (brandsResult.data as AmazonBrand[]) : [];

  details.push({
    path: "/brands",
    method: "GET",
    httpStatus: brandsResult.status,
    note:
      brandsResult.status === 200
        ? `Found ${brands.length} brand${brands.length === 1 ? "" : "s"} linked to this Ads profile.`
        : brandsResult.status === 403
          ? "Amazon returned Forbidden (403) -- this Ads connection cannot see Brand data at all."
          : brandsResult.status === 404
            ? "Amazon returned Not Found (404) for /brands -- unexpected for a working Ads connection."
            : `HTTP ${brandsResult.status ?? "request failed"}`
  });

  if (brandsResult.status === 403) {
    return {
      ok: true,
      connected: true,
      verdict: "ACCESS_DENIED",
      message: "Amazon returned Forbidden (403) on /brands. This Ads connection does not have Brand-linked access yet.",
      brands: [],
      discoveredStores: [],
      storePages: [],
      details
    };
  }

  if (brandsResult.status === 200 && brands.length === 0) {
    return {
      ok: true,
      connected: true,
      verdict: "PROFILE_NOT_BRAND_LINKED",
      message:
        "The connected Amazon Ads profile does not see any registered Brand entities. Your brands may be registered under Brand Registry, but this specific Ads profile/account isn't linked to them.",
      brands: [],
      discoveredStores: [],
      storePages: [],
      details
    };
  }

  // Step 2 (per Amazon Ads API support, case 2026-09-22): GET /v2/stores was permanently
  // deprecated and shut off 2026-06-01 -- it is no longer called here at all. The real path is
  // POST /brand/stores/v1/stores/list, which needs an ENTITY_ID identifier to look up each
  // Store's own entity id (a seller-profile Store's id is a separate sub-entity, not
  // necessarily the same as the brandEntityId from /brands). Every already-known, confirmed-
  // real ENTITY_ID on this account -- each brand's own brandEntityId -- is tried as a candidate
  // identifier, and Amazon's real raw response for each is recorded.
  const candidates = brands
    .filter((brand) => typeof brand.brandEntityId === "string" && brand.brandEntityId.trim())
    .map((brand) => ({
      label: brand.brandRegistryName ?? brand.brandEntityId ?? "unknown brand",
      identifier: brand.brandEntityId as string
    }));

  const seenEntityIds = new Set<string>();
  const discoveredStores: DiscoveredStore[] = [];

  for (const candidate of candidates) {
    const result = await callPost("/brand/stores/v1/stores/list", {
      identifier: candidate.identifier,
      identifierType: "ENTITY_ID"
    });

    details.push({
      path: "/brand/stores/v1/stores/list",
      method: "POST",
      requestBody: { identifier: candidate.identifier, identifierType: "ENTITY_ID" },
      httpStatus: result.status,
      note:
        result.status === 200
          ? `Lookup using ${candidate.label}'s brandEntityId (${candidate.identifier}) succeeded.`
          : `Lookup using ${candidate.label}'s brandEntityId (${candidate.identifier}) returned HTTP ${result.status ?? "request failed"}: ${JSON.stringify(result.data).slice(0, 300)}`
    });

    if (result.status === 200) {
      const foundIds = extractEntityIdCandidates(result.data, seenEntityIds);
      for (const storeEntityId of foundIds) {
        discoveredStores.push({
          fromCandidateLabel: candidate.label,
          fromCandidateIdentifier: candidate.identifier,
          storeEntityId,
          raw: (result.data as Record<string, unknown>) ?? {}
        });
      }
    }
  }

  // Step 3: for every distinct store entity id actually discovered, fetch its real store pages.
  const storePages: AmazonAdsStoresProbeResult["storePages"] = [];
  for (const store of discoveredStores) {
    const result = await callPost("/brand/stores/v1/storePages/list", {
      identifier: store.storeEntityId,
      identifierType: "ENTITY_ID"
    });

    const pageCount = Array.isArray(result.data)
      ? result.data.length
      : result.data && typeof result.data === "object" && Array.isArray((result.data as { storePages?: unknown[] }).storePages)
        ? (result.data as { storePages: unknown[] }).storePages.length
        : null;

    details.push({
      path: "/brand/stores/v1/storePages/list",
      method: "POST",
      requestBody: { identifier: store.storeEntityId, identifierType: "ENTITY_ID" },
      httpStatus: result.status,
      note:
        result.status === 200
          ? `Store pages fetched for entity ${store.storeEntityId} (from ${store.fromCandidateLabel}) -- ${pageCount ?? "unknown"} page(s).`
          : `Store pages lookup for entity ${store.storeEntityId} returned HTTP ${result.status ?? "request failed"}: ${JSON.stringify(result.data).slice(0, 300)}`
    });

    storePages.push({ storeEntityId: store.storeEntityId, httpStatus: result.status, pageCount, raw: result.data });
  }

  // Fallback: if brandEntityId candidates found no store ids at all, also try each brand's
  // brandEntityId directly against storePages/list -- some accounts may not have a separate
  // store sub-entity and the brandEntityId itself is already the right identifier.
  if (discoveredStores.length === 0) {
    for (const candidate of candidates) {
      const result = await callPost("/brand/stores/v1/storePages/list", {
        identifier: candidate.identifier,
        identifierType: "ENTITY_ID"
      });

      const pageCount = Array.isArray(result.data)
        ? result.data.length
        : result.data && typeof result.data === "object" && Array.isArray((result.data as { storePages?: unknown[] }).storePages)
          ? (result.data as { storePages: unknown[] }).storePages.length
          : null;

      details.push({
        path: "/brand/stores/v1/storePages/list",
        method: "POST",
        requestBody: { identifier: candidate.identifier, identifierType: "ENTITY_ID" },
        httpStatus: result.status,
        note:
          result.status === 200
            ? `Direct storePages lookup using ${candidate.label}'s brandEntityId succeeded -- ${pageCount ?? "unknown"} page(s).`
            : `Direct storePages lookup using ${candidate.label}'s brandEntityId returned HTTP ${result.status ?? "request failed"}: ${JSON.stringify(result.data).slice(0, 300)}`
      });

      storePages.push({ storeEntityId: candidate.identifier, httpStatus: result.status, pageCount, raw: result.data });
    }
  }

  const successfulPages = storePages.filter((p) => p.httpStatus === 200);
  const brandNames = brands.map((b) => b.brandRegistryName).filter(Boolean).join(", ") || "unnamed";

  let verdict: AmazonAdsStoresProbeResult["verdict"];
  let message: string;

  if (successfulPages.length > 0) {
    verdict = "ACCESS_CONFIRMED";
    message = `Real Brand Store page data was retrieved for ${successfulPages.length} store${successfulPages.length === 1 ? "" : "s"} across ${brandNames}. The Amazon-support-confirmed replacement endpoint (POST /brand/stores/v1/storePages/list) works through this connection.`;
  } else if (discoveredStores.length > 0) {
    verdict = "STORE_ID_FOUND_PAGES_BLOCKED";
    message = `Found ${discoveredStores.length} store entity id(s) via /brand/stores/v1/stores/list, but the follow-up storePages/list call did not return 200 for any of them. See "details" below for Amazon's exact error on each -- worth forwarding back to the same Amazon Ads API support case for a precise follow-up.`;
  } else {
    verdict = "STORES_LIST_NEEDS_FOLLOWUP";
    message = `Could not discover a working store entity id for ${brandNames} using either /brand/stores/v1/stores/list or a direct storePages/list attempt with each brand's brandEntityId. See "details" below for Amazon's exact raw response on each attempt -- this is the concrete evidence to send back to the Amazon Ads API support case, since the "advertiser entityId" Amazon's reply referenced wasn't something this app had a confirmed source for.`;
  }

  return {
    ok: true,
    connected: true,
    verdict,
    message,
    brands,
    discoveredStores,
    storePages,
    details
  };
}
