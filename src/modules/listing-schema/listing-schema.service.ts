import axios from "axios";
import { supabase } from "../../db/supabase";
import { requireConnectedConnection } from "../amazon-sp/amazon-sp.service";
import { amazonSpGet } from "../amazon-sp/amazon-sp-client.service";
import { getAmazonSpAccessToken } from "../amazon-sp/amazon-sp-token.service";
import { AmazonSchemaCacheRow, SchemaAttributeStatus, SchemaReadinessReport } from "./listing-schema.types";

const SCHEMA_CACHE_MAX_AGE_DAYS = 30;

// Maps Amazon's real attribute names (confirmed live from your account's Listings Items
// responses) to the corresponding Product Passport field we already track, plus a
// founder-facing label. Anything required by Amazon but not in this map is reported as
// "UNTRACKED" rather than silently ignored or falsely marked ready.
const ATTRIBUTE_TO_PASSPORT_FIELD: Record<string, { field: string; label: string }> = {
  item_name: { field: "productName", label: "Product Title" },
  bullet_point: { field: "keyFeatures", label: "Bullet Points" },
  brand: { field: "brand", label: "Brand" },
  color: { field: "color", label: "Color" },
  color_name: { field: "color", label: "Color" },
  material_type: { field: "material", label: "Material" },
  material: { field: "material", label: "Material" },
  item_dimensions: { field: "dimensions", label: "Dimensions" },
  item_length_width_height: { field: "dimensions", label: "Dimensions" },
  item_weight: { field: "weight", label: "Weight" },
  main_product_image_locator: { field: "imageUrls", label: "Main Product Image" },
  purchasable_offer: { field: "sellingPrice", label: "Price" },
  list_price: { field: "sellingPrice", label: "Price" }
};

function isFieldPresent(passport: Record<string, unknown>, field: string): boolean {
  const value = passport[field];
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

async function getCachedSchema(productType: string, marketplaceId: string): Promise<AmazonSchemaCacheRow | null> {
  const { data, error } = await supabase
    .from("amazon_schema_cache")
    .select("*")
    .eq("product_type", productType)
    .eq("marketplace_id", marketplaceId)
    .maybeSingle();

  if (error || !data) return null;

  const ageMs = Date.now() - new Date(data.fetched_at).getTime();
  const maxAgeMs = SCHEMA_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) return null;

  return data as AmazonSchemaCacheRow;
}

async function fetchAndCacheProductTypeSchema(
  sellerId: string,
  productType: string
): Promise<{ requiredAttributes: string[]; source: "FETCHED_LIVE" }> {
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);

  const definition = await amazonSpGet<{
    schema?: { link?: { resource?: string } };
  }>({
    path: `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`,
    query: {
      sellerId: connection.amazon_seller_id,
      marketplaceIds: [connection.marketplace_id],
      requirements: "LISTING"
    },
    accessToken,
    region: connection.region,
    stage: "GET_PRODUCT_TYPE_DEFINITION"
  });

  const schemaUrl = definition?.schema?.link?.resource;
  if (!schemaUrl) {
    throw new Error(`Amazon did not return a schema link for product type "${productType}".`);
  }

  const schemaResponse = await axios.get<{ required?: string[] }>(schemaUrl, { timeout: 15000 });
  const requiredAttributes = Array.isArray(schemaResponse.data?.required) ? schemaResponse.data.required : [];

  await supabase
    .from("amazon_schema_cache")
    .upsert(
      {
        product_type: productType,
        marketplace_id: connection.marketplace_id,
        required_attributes: requiredAttributes,
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      { onConflict: "product_type,marketplace_id" }
    );

  return { requiredAttributes, source: "FETCHED_LIVE" };
}

async function getRequiredAttributes(
  sellerId: string,
  productType: string,
  marketplaceId: string
): Promise<{ requiredAttributes: string[]; source: "CACHED" | "FETCHED_LIVE" | "UNAVAILABLE" }> {
  const cached = await getCachedSchema(productType, marketplaceId);
  if (cached) {
    return { requiredAttributes: cached.required_attributes, source: "CACHED" };
  }

  try {
    const fresh = await fetchAndCacheProductTypeSchema(sellerId, productType);
    return fresh;
  } catch (error) {
    return { requiredAttributes: [], source: "UNAVAILABLE" };
  }
}

export async function checkListingSchemaReadiness(input: { sellerId: string; sku: string }): Promise<SchemaReadinessReport> {
  const { sellerId, sku } = input;

  const { data: passport, error: passportError } = await supabase
    .from("product_passports")
    .select("sku, product_type, product_name, key_features, brand, color, material, dimensions, weight, image_urls, selling_price")
    .eq("seller_id", sellerId)
    .eq("sku", sku)
    .maybeSingle();

  if (passportError || !passport) {
    throw new Error(`Could not find a Product Passport for SKU "${sku}".`);
  }

  const productType = passport.product_type as string | null;
  const connection = await requireConnectedConnection(sellerId);
  const marketplaceId = connection.marketplace_id;

  if (!productType) {
    return {
      ok: true,
      sku,
      productType: null,
      marketplaceId,
      schemaSource: "UNAVAILABLE",
      requiredAttributeCount: 0,
      attributes: [],
      missingCount: 0,
      untrackedCount: 0,
      readyForSubmission: false,
      summaryMessage: "Product type is not known yet for this SKU. Sync listings from Amazon first.",
      checkedAt: new Date().toISOString(),
      warning: "No product type on file — cannot fetch Amazon's schema requirements yet."
    };
  }

  const { requiredAttributes, source } = await getRequiredAttributes(sellerId, productType, marketplaceId);

  const passportRecord: Record<string, unknown> = {
    productName: passport.product_name,
    keyFeatures: passport.key_features,
    brand: passport.brand,
    color: passport.color,
    material: passport.material,
    dimensions: passport.dimensions,
    weight: passport.weight,
    imageUrls: passport.image_urls,
    sellingPrice: passport.selling_price
  };

  const attributes: SchemaAttributeStatus[] = requiredAttributes.map((attribute) => {
    const mapping = ATTRIBUTE_TO_PASSPORT_FIELD[attribute];
    if (!mapping) {
      return { attribute, label: attribute, status: "UNTRACKED" as const };
    }
    const present = isFieldPresent(passportRecord, mapping.field);
    return { attribute, label: mapping.label, status: present ? ("KNOWN" as const) : ("MISSING" as const) };
  });

  const missingCount = attributes.filter((item) => item.status === "MISSING").length;
  const untrackedCount = attributes.filter((item) => item.status === "UNTRACKED").length;
  const readyForSubmission = source !== "UNAVAILABLE" && missingCount === 0 && untrackedCount === 0;

  const summaryMessage = source === "UNAVAILABLE"
    ? "Could not reach Amazon's schema for this product type. Try again shortly."
    : readyForSubmission
      ? "This SKU has everything Amazon's schema requires, based on what your Product Passport tracks."
      : `${missingCount + untrackedCount} answer${missingCount + untrackedCount === 1 ? "" : "s"} needed to make this Amazon-ready.`;

  return {
    ok: true,
    sku,
    productType,
    marketplaceId,
    schemaSource: source,
    requiredAttributeCount: requiredAttributes.length,
    attributes,
    missingCount,
    untrackedCount,
    readyForSubmission,
    summaryMessage,
    checkedAt: new Date().toISOString(),
    warning: source === "UNAVAILABLE" ? "Amazon schema fetch failed. Will retry on next check." : undefined
  };
}
