import { supabase } from "../../db/supabase";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import {
  availableImageFields,
  normalizeProductMedia
} from "./product-media-normalizer";

type ProductMediaDebugSample = {
  sku: string | null;
  asin: string | null;
  productName: string | null;
  mainImageUrl: string | null;
  imageSource: string | null;
  availableImageFields: string[];
  rawKeys: string[];
};

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeKey(value: unknown): string | null {
  return cleanText(value)?.toLowerCase() ?? null;
}

function productKey(sku: string | null, asin: string | null, fallback: string): string {
  const skuKey = normalizeKey(sku);
  const asinKey = normalizeKey(asin);
  return skuKey ? `sku:${skuKey}` : asinKey ? `asin:${asinKey}` : fallback;
}

function rawKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).slice(0, 60)
    : [];
}

function buildSample(input: {
  passport: ProductPassportRow | null;
  listing: AmazonSpListingRow | null;
}): ProductMediaDebugSample {
  const media = normalizeProductMedia([input.listing, input.passport], {
    lastImageSyncAt: input.listing?.last_synced_at ?? input.listing?.updated_at ?? input.passport?.updated_at ?? null,
    amazonImagePreferred: Boolean(input.listing)
  });
  const rawPayload = input.listing?.raw_payload ?? null;

  return {
    sku: cleanText(input.passport?.sku) ?? cleanText(input.listing?.sku),
    asin: cleanText(input.passport?.asin) ?? cleanText(input.listing?.asin),
    productName: cleanText(input.passport?.product_name) ?? cleanText(input.listing?.product_name),
    mainImageUrl: media.mainImageUrl,
    imageSource: media.imageSource,
    availableImageFields: availableImageFields([input.listing, input.passport, rawPayload]),
    rawKeys: rawKeys(rawPayload)
  };
}

export async function getProductMediaDebug(input: {
  sellerId: string;
  limit: number;
}) {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
  const [listingsResult, passportsResult] = await Promise.all([
    supabase
      .from("amazon_sp_listings")
      .select("*")
      .eq("seller_id", sellerId)
      .order("last_synced_at", { ascending: false })
      .limit(limit),
    supabase
      .from("product_passports")
      .select("*")
      .eq("seller_id", sellerId)
      .neq("status", "ARCHIVED")
      .order("updated_at", { ascending: false })
      .limit(limit)
  ]);

  if (listingsResult.error) {
    throw new Error("Could not load Amazon listings for product media debug.");
  }

  if (passportsResult.error) {
    throw new Error("Could not load product passports for product media debug.");
  }

  const listings = (listingsResult.data ?? []) as AmazonSpListingRow[];
  const passports = (passportsResult.data ?? []) as ProductPassportRow[];
  const passportBySku = new Map(passports.map((row) => [normalizeKey(row.sku), row]).filter((entry): entry is [string, ProductPassportRow] => Boolean(entry[0])));
  const passportByAsin = new Map(passports.map((row) => [normalizeKey(row.asin), row]).filter((entry): entry is [string, ProductPassportRow] => Boolean(entry[0])));
  const samplesByKey = new Map<string, ProductMediaDebugSample>();

  for (const listing of listings) {
    const skuKey = normalizeKey(listing.sku);
    const asinKey = normalizeKey(listing.asin);
    const passport = (skuKey ? passportBySku.get(skuKey) : undefined) ?? (asinKey ? passportByAsin.get(asinKey) : undefined) ?? null;
    samplesByKey.set(productKey(listing.sku, listing.asin, `listing:${listing.id}`), buildSample({ listing, passport }));
  }

  for (const passport of passports) {
    const key = productKey(passport.sku, passport.asin, `passport:${passport.id}`);
    if (!samplesByKey.has(key)) {
      samplesByKey.set(key, buildSample({ listing: null, passport }));
    }
  }

  const samples = Array.from(samplesByKey.values()).slice(0, limit);
  const withImage = samples.filter((sample) => Boolean(sample.mainImageUrl)).length;

  return {
    ok: true,
    totalChecked: samples.length,
    withImage,
    withoutImage: samples.length - withImage,
    samples
  };
}
