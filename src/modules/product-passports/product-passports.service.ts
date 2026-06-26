import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
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

function toSafeProductPassport(row: ProductPassportRow): SafeProductPassportRow {
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
    imageUrls: row.image_urls ?? [],
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
}): Promise<SafeProductPassportRow[]> {
  let query = supabase
    .from("product_passports")
    .select("*")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(100);

  if (input.status) {
    query = query.eq("status", input.status);
  }

  const { data, error } = await query;

  if (error) {
    logProductPassportError("Could not list product passports.", error);
    throw new Error("Could not load product passports from Supabase.");
  }

  return ((data ?? []) as ProductPassportRow[]).map(toSafeProductPassport);
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

  return data ? toSafeProductPassport(data) : null;
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

  return toSafeProductPassport(data);
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

  return toSafeProductPassport(data);
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

  return toSafeProductPassport(data);
}
