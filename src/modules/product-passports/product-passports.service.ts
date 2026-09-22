import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { ProductImageStatus } from "../product-media/product-media-normalizer";
import {
  ProductPassportInput,
  ProductPassportRow,
  ProductPassportStatus,
  ProductPassportUpdateInput,
  SafeProductPassportRow
} from "./product-passports.types";

export const PRODUCT_PASSPORT_STATUSES: ProductPassportStatus[] = [
  "DRAFT",
  "ACTIVE",
  "NEEDS_REVIEW",
  "ARCHIVED"
];

type ProductMediaRow = {
  id: string;
  seller_id: string;
  sku: string | null;
  asin: string | null;
  product_name: string | null;
  main_image_url: string | null;
  image_urls: unknown[] | null;
  image_source: string | null;
  image_status: ProductImageStatus | string | null;
  last_image_sync_at: string | null;
  created_at: string;
  updated_at: string;
};

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanArray(value: unknown[] | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sanitizeErrorMessage(message: string): string {
  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.AMAZON_LWA_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_SECRET,
    env.ENCRYPTION_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (safeMessage, secretValue) => safeMessage.replaceAll(secretValue, "[REDACTED]"),
    message
  );
}

function logProductPassportError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function normalizeKey(value: unknown): string | null {
  return cleanText(value == null ? null : String(value))?.toLowerCase() ?? null;
}

function normalizeSellerId(value: unknown): string {
  return cleanText(value == null ? null : String(value)) ?? "default";
}

function normalizeAsin(value: unknown): string | null {
  return cleanText(value == null ? null : String(value))?.toUpperCase() ?? null;
}

function normalizeSku(value: unknown): string | null {
  return cleanText(value == null ? null : String(value));
}

function normalizeSkuKey(value: unknown): string | null {
  return normalizeKey(value);
}

function cleanImageUrls(value: unknown): string[] {
  const seen = new Set<string>();
  const urls = (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item == null ? null : String(item)))
    .filter((item): item is string => Boolean(item));

  return urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function mergeImageUrls(...values: unknown[]): string[] {
  return cleanImageUrls(values.flatMap((value) => Array.isArray(value) ? value : [value]));
}

function buildListingMaps(listings: AmazonSpListingRow[]): {
  bySku: Map<string, AmazonSpListingRow>;
  byAsin: Map<string, AmazonSpListingRow>;
} {
  const bySku = new Map<string, AmazonSpListingRow>();
  const byAsin = new Map<string, AmazonSpListingRow>();

  for (const listing of listings) {
    const skuKey = normalizeKey(listing.sku);
    const asinKey = normalizeKey(listing.asin);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, listing);
    if (asinKey && !byAsin.has(asinKey)) byAsin.set(asinKey, listing);
  }

  return { bySku, byAsin };
}

function matchListingForPassport(
  row: ProductPassportRow,
  maps: { bySku: Map<string, AmazonSpListingRow>; byAsin: Map<string, AmazonSpListingRow> }
): AmazonSpListingRow | null {
  const skuKey = normalizeKey(row.sku);
  const asinKey = normalizeKey(row.asin);
  return (skuKey ? maps.bySku.get(skuKey) : undefined) ?? (asinKey ? maps.byAsin.get(asinKey) : undefined) ?? null;
}

async function loadListingsForSeller(sellerId: string): Promise<AmazonSpListingRow[]> {
  const { data, error } = await supabase
    .from("amazon_sp_listings")
    .select("*")
    .eq("seller_id", cleanText(sellerId) ?? "default")
    .order("last_synced_at", { ascending: false })
    .limit(1000);

  if (error) {
    logProductPassportError("Could not load Amazon listings for product passport images.", error);
    return [];
  }

  return (data ?? []) as AmazonSpListingRow[];
}

async function loadProductMediaForPassports(sellerId: string, rows: ProductPassportRow[]): Promise<ProductMediaRow[]> {
  const normalizedSellerId = normalizeSellerId(sellerId);
  const asinKeys = new Set(rows.map((row) => normalizeAsin(row.asin)).filter((value): value is string => Boolean(value)));
  const skuValues = new Set(rows.map((row) => normalizeSku(row.sku)).filter((value): value is string => Boolean(value)));
  const skuKeys = new Set(rows.map((row) => normalizeSkuKey(row.sku)).filter((value): value is string => Boolean(value)));

  if (!asinKeys.size && !skuValues.size) {
    return [];
  }

  const matchedRows = new Map<string, ProductMediaRow>();
  const addMatchedRows = (mediaRows: ProductMediaRow[]) => {
    for (const mediaRow of mediaRows) {
      const asinKey = normalizeAsin(mediaRow.asin);
      const skuKey = normalizeSkuKey(mediaRow.sku);
      if ((asinKey && asinKeys.has(asinKey)) || (skuKey && skuKeys.has(skuKey))) {
        matchedRows.set(mediaRow.id, mediaRow);
      }
    }
  };

  const [asinResult, skuResult] = await Promise.all([
    asinKeys.size
      ? supabase
          .from("product_media")
          .select("*")
          .eq("seller_id", normalizedSellerId)
          .in("asin", Array.from(asinKeys))
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    skuValues.size
      ? supabase
          .from("product_media")
          .select("*")
          .eq("seller_id", normalizedSellerId)
          .in("sku", Array.from(skuValues))
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null })
  ]);

  if (asinResult.error) {
    logProductPassportError("Could not load product_media by ASIN for product passport images.", asinResult.error);
  } else {
    addMatchedRows((asinResult.data ?? []) as ProductMediaRow[]);
  }

  if (skuResult.error) {
    logProductPassportError("Could not load product_media by SKU for product passport images.", skuResult.error);
  } else {
    addMatchedRows((skuResult.data ?? []) as ProductMediaRow[]);
  }

  const needsNormalizedFallback = rows.some((row) => {
    const asinKey = normalizeAsin(row.asin);
    const skuKey = normalizeSkuKey(row.sku);
    return !Array.from(matchedRows.values()).some((mediaRow) => {
      const mediaAsinKey = normalizeAsin(mediaRow.asin);
      const mediaSkuKey = normalizeSkuKey(mediaRow.sku);
      return (asinKey && mediaAsinKey === asinKey) || (skuKey && mediaSkuKey === skuKey);
    });
  });

  if (!needsNormalizedFallback) {
    return Array.from(matchedRows.values());
  }

  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("product_media")
      .select("*")
      .eq("seller_id", normalizedSellerId)
      .order("updated_at", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      logProductPassportError("Could not load normalized product_media fallback for product passport images.", error);
      break;
    }

    const pageRows = (data ?? []) as ProductMediaRow[];
    addMatchedRows(pageRows);

    if (pageRows.length < pageSize) {
      break;
    }
  }

  return Array.from(matchedRows.values());
}

function buildProductMediaMaps(rows: ProductMediaRow[]): {
  bySku: Map<string, ProductMediaRow>;
  byAsin: Map<string, ProductMediaRow>;
} {
  const bySku = new Map<string, ProductMediaRow>();
  const byAsin = new Map<string, ProductMediaRow>();

  for (const row of rows) {
    const skuKey = normalizeSkuKey(row.sku);
    const asinKey = normalizeAsin(row.asin);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, row);
    if (asinKey && !byAsin.has(asinKey)) byAsin.set(asinKey, row);
  }

  return { bySku, byAsin };
}

type ProductMediaMatch = {
  row: ProductMediaRow | null;
  keyUsed: "asin" | "sku" | null;
};

function matchProductMediaForPassport(
  row: ProductPassportRow,
  maps: { bySku: Map<string, ProductMediaRow>; byAsin: Map<string, ProductMediaRow> }
): ProductMediaMatch {
  const asinKey = normalizeAsin(row.asin);
  const skuKey = normalizeSkuKey(row.sku);
  const skuMatch = skuKey ? maps.bySku.get(skuKey) : undefined;
  if (skuMatch) {
    return { row: skuMatch, keyUsed: "sku" };
  }

  const asinMatch = asinKey ? maps.byAsin.get(asinKey) : undefined;
  if (asinMatch) {
    return { row: asinMatch, keyUsed: "asin" };
  }

  return { row: null, keyUsed: null };
}

async function findListingForPassport(row: ProductPassportRow): Promise<AmazonSpListingRow | null> {
  const listings = await loadListingsForSeller(row.seller_id);
  return matchListingForPassport(row, buildListingMaps(listings));
}

async function findProductMediaForPassport(row: ProductPassportRow): Promise<ProductMediaMatch> {
  const rows = await loadProductMediaForPassports(row.seller_id, [row]);
  return matchProductMediaForPassport(row, buildProductMediaMaps(rows));
}

function toSafeProductPassport(
  row: ProductPassportRow,
  listing: AmazonSpListingRow | null = null,
  productMediaMatch: ProductMediaMatch | ProductMediaRow | null = null
): SafeProductPassportRow {
  const productMedia = productMediaMatch && "row" in productMediaMatch ? productMediaMatch.row : productMediaMatch;
  const mediaJoinKeyUsed = productMediaMatch && "row" in productMediaMatch ? productMediaMatch.keyUsed : productMedia ? "asin" : null;
  const passportImageUrls = cleanImageUrls(row.image_urls);
  const productMediaImageUrls = mergeImageUrls(productMedia?.main_image_url, productMedia?.image_urls);
  const productMediaMainImageUrl = cleanText(productMedia?.main_image_url) ?? productMediaImageUrls[0] ?? null;
  const imageUrls = mergeImageUrls(passportImageUrls, productMediaImageUrls);
  const mainImageUrl = passportImageUrls[0] ?? productMediaMainImageUrl ?? null;
  const imageStatus = productMedia ? cleanText(productMedia.image_status) ?? "FOUND" : "NOT_SYNCED";
  const imageSource = productMedia ? cleanText(productMedia.image_source) : null;
  const lastImageSyncAt = productMedia ? productMedia.last_image_sync_at : null;

  return {
    id: row.id,
    sellerId: row.seller_id,
    sku: row.sku,
    asin: row.asin,
    productName: row.product_name,
    brand: row.brand,
    category: row.category,
    subCategory: row.sub_category,
    productType: row.product_type,
    sellingPrice: toNumberOrNull(row.selling_price),
    targetCustomer: row.target_customer,
    useCase: row.use_case,
    material: row.material,
    color: row.color,
    dimensions: row.dimensions,
    weight: row.weight,
    packageContents: row.package_contents,
    keyFeatures: row.key_features ?? [],
    customerObjections: row.customer_objections ?? [],
    competitorAsins: row.competitor_asins ?? [],
    imageUrls,
    mainImageUrl,
    imageUrl: mainImageUrl,
    amazonImageUrl: productMediaMainImageUrl,
    imageSource,
    lastImageSyncAt,
    images: imageUrls,
    imageStatus,
    mediaJoinMatched: Boolean(productMedia),
    mediaJoinKeyUsed,
    mediaAsin: productMedia?.asin ?? null,
    mediaSku: productMedia?.sku ?? null,
    mediaTableId: productMedia?.id ?? null,
    supplierName: row.supplier_name,
    supplierCost: toNumberOrNull(row.supplier_cost),
    packagingNotes: row.packaging_notes,
    brandPositioning: row.brand_positioning,
    seoKeywords: row.seo_keywords ?? [],
    complianceNotes: row.compliance_notes,
    internalNotes: row.internal_notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toInsertRow(input: ProductPassportInput) {
  return {
    seller_id: cleanText(input.sellerId) ?? "default",
    sku: cleanText(input.sku),
    asin: cleanText(input.asin),
    product_name: input.productName.trim(),
    brand: cleanText(input.brand) ?? "Leafy Dew",
    category: cleanText(input.category),
    sub_category: cleanText(input.subCategory),
    product_type: cleanText(input.productType),
    selling_price: toNumberOrNull(input.sellingPrice),
    target_customer: cleanText(input.targetCustomer),
    use_case: cleanText(input.useCase),
    material: cleanText(input.material),
    color: cleanText(input.color),
    dimensions: cleanText(input.dimensions),
    weight: cleanText(input.weight),
    package_contents: cleanText(input.packageContents),
    key_features: cleanArray(input.keyFeatures),
    customer_objections: cleanArray(input.customerObjections),
    competitor_asins: cleanArray(input.competitorAsins),
    image_urls: cleanArray(input.imageUrls),
    supplier_name: cleanText(input.supplierName),
    supplier_cost: toNumberOrNull(input.supplierCost),
    packaging_notes: cleanText(input.packagingNotes),
    brand_positioning: cleanText(input.brandPositioning),
    seo_keywords: cleanArray(input.seoKeywords),
    compliance_notes: cleanText(input.complianceNotes),
    internal_notes: cleanText(input.internalNotes),
    status: input.status ?? "DRAFT"
  };
}

function toUpdateRow(input: ProductPassportUpdateInput) {
  const updateRow: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (input.sellerId !== undefined) updateRow.seller_id = cleanText(input.sellerId) ?? "default";
  if (input.sku !== undefined) updateRow.sku = cleanText(input.sku);
  if (input.asin !== undefined) updateRow.asin = cleanText(input.asin);
  if (input.productName !== undefined) updateRow.product_name = input.productName.trim();
  if (input.brand !== undefined) updateRow.brand = cleanText(input.brand);
  if (input.category !== undefined) updateRow.category = cleanText(input.category);
  if (input.subCategory !== undefined) updateRow.sub_category = cleanText(input.subCategory);
  if (input.productType !== undefined) updateRow.product_type = cleanText(input.productType);
  if (input.sellingPrice !== undefined) updateRow.selling_price = toNumberOrNull(input.sellingPrice);
  if (input.targetCustomer !== undefined) updateRow.target_customer = cleanText(input.targetCustomer);
  if (input.useCase !== undefined) updateRow.use_case = cleanText(input.useCase);
  if (input.material !== undefined) updateRow.material = cleanText(input.material);
  if (input.color !== undefined) updateRow.color = cleanText(input.color);
  if (input.dimensions !== undefined) updateRow.dimensions = cleanText(input.dimensions);
  if (input.weight !== undefined) updateRow.weight = cleanText(input.weight);
  if (input.packageContents !== undefined) updateRow.package_contents = cleanText(input.packageContents);
  if (input.keyFeatures !== undefined) updateRow.key_features = cleanArray(input.keyFeatures);
  if (input.customerObjections !== undefined) updateRow.customer_objections = cleanArray(input.customerObjections);
  if (input.competitorAsins !== undefined) updateRow.competitor_asins = cleanArray(input.competitorAsins);
  if (input.imageUrls !== undefined) updateRow.image_urls = cleanArray(input.imageUrls);
  if (input.supplierName !== undefined) updateRow.supplier_name = cleanText(input.supplierName);
  if (input.supplierCost !== undefined) updateRow.supplier_cost = toNumberOrNull(input.supplierCost);
  if (input.packagingNotes !== undefined) updateRow.packaging_notes = cleanText(input.packagingNotes);
  if (input.brandPositioning !== undefined) updateRow.brand_positioning = cleanText(input.brandPositioning);
  if (input.seoKeywords !== undefined) updateRow.seo_keywords = cleanArray(input.seoKeywords);
  if (input.complianceNotes !== undefined) updateRow.compliance_notes = cleanText(input.complianceNotes);
  if (input.internalNotes !== undefined) updateRow.internal_notes = cleanText(input.internalNotes);
  if (input.status !== undefined) updateRow.status = input.status;

  return updateRow;
}

export function isProductPassportStatus(status: string): status is ProductPassportStatus {
  return PRODUCT_PASSPORT_STATUSES.includes(status as ProductPassportStatus);
}

export async function listProductPassports(input: {
  sellerId: string;
  status?: ProductPassportStatus;
  limit?: number;
}): Promise<SafeProductPassportRow[]> {
  const sellerIdValue = cleanText(input.sellerId) ?? "default";

  // A founder should never see a silently-truncated catalog. If a caller passes an
  // explicit limit, respect it (used by internal batch jobs); otherwise page through
  // every row so the full catalog always comes back, regardless of size.
  const explicitLimit = input.limit ? Math.min(Math.max(Math.floor(input.limit), 1), 500) : undefined;
  const pageSize = 500;
  const allRows: ProductPassportRow[] = [];

  for (let from = 0; ; from += pageSize) {
    let query = supabase
      .from("product_passports")
      .select("*")
      .eq("seller_id", sellerIdValue)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);

    if (input.status) {
      query = query.eq("status", input.status);
    }

    const { data, error } = await query;

    if (error) {
      logProductPassportError("Could not list product passports.", error);
      throw new Error("Could not load product passports from Supabase.");
    }

    const pageRows = (data ?? []) as ProductPassportRow[];
    allRows.push(...pageRows);

    if (explicitLimit && allRows.length >= explicitLimit) break;
    if (pageRows.length < pageSize) break;
  }

  const rows = explicitLimit ? allRows.slice(0, explicitLimit) : allRows;
  const sellerId = normalizeSellerId(input.sellerId);
  const [listings, productMediaRows] = await Promise.all([
    loadListingsForSeller(sellerId),
    loadProductMediaForPassports(sellerId, rows)
  ]);
  const listingMaps = buildListingMaps(listings);
  const productMediaMaps = buildProductMediaMaps(productMediaRows);

  return rows.map((row) => toSafeProductPassport(
    row,
    matchListingForPassport(row, listingMaps),
    matchProductMediaForPassport(row, productMediaMaps)
  ));
}

export async function getProductPassportById(id: string): Promise<SafeProductPassportRow | null> {
  const { data, error } = await supabase
    .from("product_passports")
    .select("*")
    .eq("id", id)
    .maybeSingle<ProductPassportRow>();

  if (error) {
    logProductPassportError("Could not load product passport.", error);
    throw new Error("Could not load product passport from Supabase.");
  }

  return data ? toSafeProductPassport(data, await findListingForPassport(data), await findProductMediaForPassport(data)) : null;
}

export async function createProductPassport(input: ProductPassportInput): Promise<SafeProductPassportRow> {
  const { data, error } = await supabase
    .from("product_passports")
    .insert(toInsertRow(input))
    .select("*")
    .single<ProductPassportRow>();

  if (error || !data) {
    if (error) {
      logProductPassportError("Could not create product passport.", error);
    }
    throw new Error(error?.code === "23505" ? "Product passport already exists for this seller." : "Could not create product passport in Supabase.");
  }

  return toSafeProductPassport(data, await findListingForPassport(data), await findProductMediaForPassport(data));
}

export async function updateProductPassport(input: {
  id: string;
  updates: ProductPassportUpdateInput;
}): Promise<SafeProductPassportRow | null> {
  const existing = await getProductPassportById(input.id);

  if (!existing) {
    return null;
  }

  const { data, error } = await supabase
    .from("product_passports")
    .update(toUpdateRow(input.updates))
    .eq("id", input.id)
    .select("*")
    .single<ProductPassportRow>();

  if (error || !data) {
    if (error) {
      logProductPassportError("Could not update product passport.", error);
    }
    throw new Error(error?.code === "23505" ? "Product passport already exists for this seller." : "Could not update product passport in Supabase.");
  }

  return toSafeProductPassport(data, await findListingForPassport(data), await findProductMediaForPassport(data));
}

// The founder confirmed (2026-09-21) that none of their real products need a safety
// certification, compliance marking, or regulatory audit -- these are ordinary household
// decor/planter items, not a regulated category. Rather than leave compliance_notes blank
// forever (which keeps dragging the Brand Readiness Trust Readiness score down for a gap that
// genuinely doesn't apply), this lets the founder apply one honest, founder-confirmed statement
// to every eligible product in a single click -- this is deliberately NOT AI-authored text: it
// is exactly what the founder told Claude directly, so the extraction-only/UNKNOWN-sentinel
// safety design used for AI-drafted compliance notes elsewhere in this module doesn't apply here.
const DEFAULT_COMPLIANCE_NOTES_TEXT =
  "Standard household decor and planter item for everyday home, gifting, and event use. Does not fall under a regulated product category, so no safety certification, compliance marking, or regulatory audit applies.";

export async function bulkApplyStandardComplianceNotes(input: {
  sellerId: string;
  text?: string | null;
}): Promise<{
  eligibleCount: number;
  updatedCount: number;
  failedCount: number;
  failedIds: string[];
  textApplied: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const text = cleanText(input.text ?? null) ?? DEFAULT_COMPLIANCE_NOTES_TEXT;

  const { data, error } = await supabase
    .from("product_passports")
    .select("id, compliance_notes, status")
    .eq("seller_id", sellerId);

  if (error) {
    logProductPassportError("Could not load product passports for bulk compliance notes update.", error);
    throw new Error("Could not load product passports from Supabase.");
  }

  const rows = (data ?? []) as Array<{ id: string; compliance_notes: string | null; status: string | null }>;
  // Only touches products that don't already have compliance notes on file (never overwrites an
  // existing value, AI-drafted or founder-entered) and skips archived products.
  const eligible = rows.filter((row) => (!row.compliance_notes || !row.compliance_notes.trim()) && row.status !== "ARCHIVED");

  let updatedCount = 0;
  const failedIds: string[] = [];

  // Sequential batches (not one giant Promise.all across 150+ rows) so this stays predictable and
  // easy to reason about -- this is a single founder-triggered click, not a background job.
  const BATCH_SIZE = 15;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        const { error: updateError } = await supabase
          .from("product_passports")
          .update({ compliance_notes: text, updated_at: new Date().toISOString() })
          .eq("id", row.id);

        if (updateError) {
          logProductPassportError(`Could not apply standard compliance notes to product passport ${row.id}.`, updateError);
        }

        return { id: row.id, ok: !updateError };
      })
    );

    for (const result of results) {
      if (result.ok) updatedCount += 1;
      else failedIds.push(result.id);
    }
  }

  return {
    eligibleCount: eligible.length,
    updatedCount,
    failedCount: failedIds.length,
    failedIds,
    textApplied: text
  };
}

// Founder-confirmed on 2026-09-22: the 22 Ziro kart/Leafy Dew "Wooden Wall Hanging Acrylic Test
// Tube Planter & Propagation Station" design/color variants missing package_contents are the same
// physical product (wooden wall-mount stand, acrylic glass tubes, self-adhesive hook) as the 19
// already-documented siblings in the same product name family -- they only differ by print/pattern.
// The name match is deliberately scoped tight to this exact phrase so it never touches the
// visually-similar but physically different "Table Top ... Mango Wood" or "Wall Planter - Wooden
// Flower Vase & Test Tube Glass Vaas" products, which are separate items with their own contents.
// Like bulkApplyStandardComplianceNotes above, this saves back exactly what the founder confirmed
// in chat and never overwrites a product that already has package_contents on file.
const TEST_TUBE_PLANTER_FAMILY_NAME_PATTERN = /wooden wall hanging acrylic test tube planter/i;
const TEST_TUBE_PLANTER_PACKAGE_CONTENTS_TEXT = "Wooden stand  \nAcrylic glass tubes  \nSelf-adhesive hook";

export async function bulkApplyTestTubePlanterPackageContents(input: {
  sellerId: string;
  text?: string | null;
}): Promise<{
  eligibleCount: number;
  updatedCount: number;
  failedCount: number;
  failedIds: string[];
  textApplied: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const text = cleanText(input.text ?? null) ?? TEST_TUBE_PLANTER_PACKAGE_CONTENTS_TEXT;

  const { data, error } = await supabase
    .from("product_passports")
    .select("id, product_name, package_contents, status")
    .eq("seller_id", sellerId);

  if (error) {
    logProductPassportError("Could not load product passports for bulk package contents update.", error);
    throw new Error("Could not load product passports from Supabase.");
  }

  const rows = (data ?? []) as Array<{
    id: string;
    product_name: string | null;
    package_contents: string | null;
    status: string | null;
  }>;
  // Only touches products in the Test Tube Planter wall-hanging family that don't already have
  // package_contents on file, and skips archived products.
  const eligible = rows.filter(
    (row) =>
      (!row.package_contents || !row.package_contents.trim()) &&
      row.status !== "ARCHIVED" &&
      TEST_TUBE_PLANTER_FAMILY_NAME_PATTERN.test(row.product_name ?? "")
  );

  let updatedCount = 0;
  const failedIds: string[] = [];

  const BATCH_SIZE = 15;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        const { error: updateError } = await supabase
          .from("product_passports")
          .update({ package_contents: text, updated_at: new Date().toISOString() })
          .eq("id", row.id);

        if (updateError) {
          logProductPassportError(`Could not apply Test Tube Planter package contents to product passport ${row.id}.`, updateError);
        }

        return { id: row.id, ok: !updateError };
      })
    );

    for (const result of results) {
      if (result.ok) updatedCount += 1;
      else failedIds.push(result.id);
    }
  }

  return {
    eligibleCount: eligible.length,
    updatedCount,
    failedCount: failedIds.length,
    failedIds,
    textApplied: text
  };
}

export async function archiveProductPassport(id: string): Promise<SafeProductPassportRow | null> {
  const existing = await getProductPassportById(id);

  if (!existing) {
    return null;
  }

  const { data, error } = await supabase
    .from("product_passports")
    .update({
      status: "ARCHIVED",
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single<ProductPassportRow>();

  if (error || !data) {
    if (error) {
      logProductPassportError("Could not archive product passport.", error);
    }
    throw new Error("Could not archive product passport in Supabase.");
  }

  return toSafeProductPassport(data, await findListingForPassport(data), await findProductMediaForPassport(data));
}

export type ProductImageLookup = {
  bySku: Map<string, string>;
  byAsin: Map<string, string>;
};

// Shared "what does this product look like" lookup used by other modules (Action Ledger,
// Listing Drafts, real-sales summaries) so their list/card responses can carry a real product
// photo URL instead of the founder seeing a generic icon while reviewing. Deliberately reuses
// listProductPassports() rather than re-deriving image logic, so this always matches whatever
// image the founder actually sees on the Product Passport / Products page.
export async function getProductImageLookup(sellerIdInput: string): Promise<ProductImageLookup> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const bySku = new Map<string, string>();
  const byAsin = new Map<string, string>();

  let passports: SafeProductPassportRow[] = [];
  try {
    passports = await listProductPassports({ sellerId });
  } catch (error) {
    logProductPassportError("Could not build product image lookup.", {
      message: error instanceof Error ? error.message : "Unknown error"
    });
    return { bySku, byAsin };
  }

  for (const passport of passports) {
    const imageUrl = cleanText(passport.imageUrl);
    if (!imageUrl) continue;

    const skuKey = normalizeSkuKey(passport.sku);
    const asinKey = normalizeAsin(passport.asin);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, imageUrl);
    if (asinKey && !byAsin.has(asinKey)) byAsin.set(asinKey, imageUrl);
  }

  return { bySku, byAsin };
}

export function lookupProductImage(
  lookup: ProductImageLookup,
  sku?: string | null,
  asin?: string | null
): string | null {
  const skuKey = normalizeSkuKey(sku);
  const asinKey = normalizeAsin(asin);
  return (skuKey ? lookup.bySku.get(skuKey) : undefined) ?? (asinKey ? lookup.byAsin.get(asinKey) : undefined) ?? null;
}
