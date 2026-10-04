import { supabase } from "../../db/supabase";
import { requireConnectedConnection } from "../amazon-sp/amazon-sp.service";
import { amazonSpGet } from "../amazon-sp/amazon-sp-client.service";
import { getAmazonSpAccessToken } from "../amazon-sp/amazon-sp-token.service";

type CatalogResponse = {
  images?: Array<{ images?: Array<{ variant?: string; link?: string; width?: number; height?: number }> }>;
  salesRanks?: Array<{
    classificationRanks?: Array<{ title?: string; rank?: number }>;
    displayGroupRanks?: Array<{ title?: string; rank?: number }>;
  }>;
  dimensions?: unknown[];
  summaries?: Array<{ browseClassification?: { displayName?: string }; websiteDisplayGroup?: string }>;
};

// Reads Amazon's public catalog record (all images incl. variants, best-seller rank,
// package dimensions, category) for each ASIN. Read-only. Oldest first, one batch per call.
export async function syncListingCatalog(input: { sellerId: string; limit?: number }) {
  const sellerId = input.sellerId || "default";
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), 40);
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);

  const { data, error } = await supabase
    .from("amazon_listing_details")
    .select("sku, asin, catalog_fetched_at")
    .eq("seller_id", sellerId)
    .not("asin", "is", null)
    .order("catalog_fetched_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  let saved = 0;
  const failed: Array<{ sku: string; reason: string }> = [];
  for (const row of data ?? []) {
    try {
      const res = await amazonSpGet<CatalogResponse>({
        path: `/catalog/2022-04-01/items/${row.asin}`,
        query: {
          marketplaceIds: [connection.marketplace_id],
          includedData: ["images", "salesRanks", "dimensions", "summaries"]
        },
        accessToken,
        region: connection.region,
        stage: "GET_CATALOG_ITEM"
      });
      const images = (res.images?.[0]?.images ?? []).filter((i) => i.link);
      const ranks = (res.salesRanks?.[0]?.classificationRanks ?? []).concat(res.salesRanks?.[0]?.displayGroupRanks ?? []);
      const best = ranks.map((r) => r.rank).filter((n): n is number => typeof n === "number").sort((a, b) => a - b)[0] ?? null;
      const { error: upErr } = await supabase
        .from("amazon_listing_details")
        .update({
          catalog_images: images,
          catalog_image_count: new Set(images.map((i) => i.variant)).size,
          sales_ranks: res.salesRanks ?? null,
          best_sales_rank: best,
          dimensions: res.dimensions ?? null,
          classifications: res.summaries ?? null,
          catalog_error: null,
          catalog_fetched_at: new Date().toISOString()
        })
        .eq("seller_id", sellerId)
        .eq("sku", row.sku);
      if (upErr) failed.push({ sku: row.sku, reason: "Could not save" });
      else saved += 1;
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 120) : "Unknown error";
      failed.push({ sku: row.sku, reason });
      await supabase
        .from("amazon_listing_details")
        .update({ catalog_error: reason, catalog_fetched_at: new Date().toISOString() })
        .eq("seller_id", sellerId)
        .eq("sku", row.sku);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: true, attempted: (data ?? []).length, saved, failedCount: failed.length, failed: failed.slice(0, 10) };
}
