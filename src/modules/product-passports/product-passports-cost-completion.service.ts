import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { ActionLedgerRow, SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { toSafeActionLedgerRow } from "../action-ledger/action-ledger.service";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import {
  ProductEconomicsRow,
  SafeProductEconomicsRow
} from "../product-economics/product-economics.types";
import {
  saveProductEconomics,
  toSafeProductEconomicsRow
} from "../product-economics/product-economics.service";
import { ProductPassportRow } from "./product-passports.types";
import {
  ProductPassportCostCompletionBulkItem,
  ProductPassportCostCompletionBulkResult,
  ProductPassportCostCompletionRow,
  ProductPassportCostCompletionSummary,
  ProductPassportCostCompletionSource,
  ProductPassportCostStatus,
  ProductPassportResolveActionsResult
} from "./product-passports-cost-completion.types";

const DEFAULT_SELLER_ID = "default";
const ACTION_RESOLVED_NOTE = "Cost data completed via Product Passport workflow";

type CostCompletionContext = {
  sellerId: string;
  listings: AmazonSpListingRow[];
  passports: ProductPassportRow[];
  economics: SafeProductEconomicsRow[];
  listingBySku: Map<string, AmazonSpListingRow>;
  listingByAsin: Map<string, AmazonSpListingRow[]>;
  passportBySku: Map<string, ProductPassportRow>;
  passportByAsin: Map<string, ProductPassportRow[]>;
  economicsBySku: Map<string, SafeProductEconomicsRow>;
  economicsByAsin: Map<string, SafeProductEconomicsRow[]>;
};

type MatchedProduct = {
  sku: string;
  asin: string | null;
  listing: AmazonSpListingRow | null;
  passport: ProductPassportRow | null;
  economics: SafeProductEconomicsRow | null;
};

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeKey(value: unknown): string | null {
  return cleanText(value)?.toLowerCase() ?? null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveNumber(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function noteValue(notes: string | null | undefined, label: string): string | null {
  if (!notes) return null;
  const match = notes.match(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im"));
  return cleanText(match?.[1]);
}

function noteNumber(notes: string | null | undefined, label: string): number | null {
  return toNumberOrNull(noteValue(notes, label));
}

function parseWeightKg(weight: string | null | undefined): number | null {
  const match = weight?.match(/(\d+(?:\.\d+)?)/);
  return match ? toNumberOrNull(match[1]) : null;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, millis: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.millis))
    .sort((a, b) => b.millis - a.millis);

  return timestamps[0]?.value ?? null;
}

function setFirstByKey<T>(map: Map<string, T>, key: string | null, value: T): void {
  if (key && !map.has(key)) {
    map.set(key, value);
  }
}

function pushByKey<T>(map: Map<string, T[]>, key: string | null, value: T): void {
  if (!key) return;
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

function sourceForProduct(input: {
  economics: SafeProductEconomicsRow | null;
  passport: ProductPassportRow | null;
  listing: AmazonSpListingRow | null;
}): ProductPassportCostCompletionSource {
  if (input.economics) return "economics";
  if (input.passport) return "product";
  return "listing";
}

function productKey(sku: string | null, asin: string | null): string | null {
  const skuKey = normalizeKey(sku);
  const asinKey = normalizeKey(asin);
  return skuKey ? `sku:${skuKey}` : asinKey ? `asin:${asinKey}` : null;
}

function costStatusFromMissingFields(missingFields: string[]): ProductPassportCostStatus {
  if (missingFields.includes("sku") || missingFields.includes("productCost") || missingFields.includes("requiredProfit") || missingFields.includes("subcategory")) {
    return "INCOMPLETE";
  }

  if (missingFields.includes("sellingPrice")) {
    return "PARTIAL";
  }

  return "COMPLETE";
}

function buildMissingFields(input: {
  sku: string | null;
  productCost: number | null;
  landedCost: number | null;
  requiredProfit: number | null;
  subcategory: string | null;
  sellingPrice: number | null;
}): string[] {
  const missingFields: string[] = [];

  if (!input.sku) missingFields.push("sku");
  if (!positiveNumber(input.productCost) && !positiveNumber(input.landedCost)) missingFields.push("productCost");
  if (!positiveNumber(input.requiredProfit)) missingFields.push("requiredProfit");
  if (!cleanText(input.subcategory)) missingFields.push("subcategory");
  if (!positiveNumber(input.sellingPrice)) missingFields.push("sellingPrice");

  return missingFields;
}

function buildCompletionRow(input: {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  listing: AmazonSpListingRow | null;
  passport: ProductPassportRow | null;
  economics: SafeProductEconomicsRow | null;
}): ProductPassportCostCompletionRow {
  const { sellerId, listing, passport, economics } = input;
  const notes = economics?.notes ?? null;
  const sku = cleanText(input.sku) ?? cleanText(economics?.sku) ?? cleanText(passport?.sku) ?? cleanText(listing?.sku);
  const asin = cleanText(input.asin) ?? cleanText(economics?.asin) ?? cleanText(passport?.asin) ?? cleanText(listing?.asin);
  const productName =
    cleanText(economics?.productName) ??
    cleanText(passport?.product_name) ??
    cleanText(listing?.product_name) ??
    sku;
  const subcategory =
    cleanText(passport?.sub_category) ??
    noteValue(notes, "Subcategory") ??
    cleanText(passport?.category) ??
    cleanText(listing?.product_type) ??
    cleanText(passport?.product_type);
  const productCost = positiveNumber(passport?.supplier_cost) ?? positiveNumber(economics?.buyingCost);
  const landedCost = positiveNumber(economics?.landedCost);
  const packagingCost = toNumberOrNull(economics?.packagingCost);
  const shippingCost = toNumberOrNull(economics?.shippingFeeEstimate);
  const manualOtherCost = noteNumber(notes, "Manual Other Fees");
  const otherCost = manualOtherCost ?? toNumberOrNull(economics?.otherCostPerUnit);
  const requiredProfit = positiveNumber(economics?.requiredProfit);
  const sellingPrice =
    positiveNumber(economics?.sellingPrice) ??
    positiveNumber(passport?.selling_price) ??
    positiveNumber(listing?.price);
  const missingFields = buildMissingFields({
    sku,
    productCost,
    landedCost,
    requiredProfit,
    subcategory,
    sellingPrice
  });

  return {
    sellerId,
    sku,
    asin,
    productName,
    title: productName,
    subcategory,
    productCost,
    landedCost,
    packagingCost,
    shippingCost,
    otherCost,
    requiredProfit,
    sellingPrice,
    currentProfitStatus: economics?.profitStatus ?? null,
    targetAcos: economics?.targetAcos ?? null,
    breakEvenAcos: economics?.breakEvenAcos ?? null,
    missingFields,
    costStatus: costStatusFromMissingFields(missingFields),
    source: sourceForProduct({ economics, passport, listing }),
    updatedAt: latestTimestamp([
      economics?.updatedAt,
      passport?.updated_at,
      listing?.updated_at,
      listing?.last_synced_at
    ]),
    existingEconomics: economics
  };
}

async function loadCostCompletionContext(sellerIdInput: string, limit = 1000): Promise<CostCompletionContext> {
  const sellerId = cleanText(sellerIdInput) ?? DEFAULT_SELLER_ID;

  const [listingsResult, passportsResult, economicsResult] = await Promise.all([
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
      .limit(limit),
    supabase
      .from("amazon_product_economics")
      .select("*")
      .eq("seller_id", sellerId)
      .order("updated_at", { ascending: false })
      .limit(limit)
  ]);

  if (listingsResult.error) {
    logger.warn("Could not load listings for Product Passport cost completion.", {
      message: listingsResult.error.message
    });
    throw new Error("Could not load Product Passport cost completion listings.");
  }

  if (passportsResult.error) {
    logger.warn("Could not load product passports for cost completion.", {
      message: passportsResult.error.message
    });
    throw new Error("Could not load Product Passport cost completion products.");
  }

  if (economicsResult.error) {
    logger.warn("Could not load product economics for cost completion.", {
      message: economicsResult.error.message
    });
    throw new Error("Could not load Product Passport cost completion economics.");
  }

  const listings = (listingsResult.data ?? []) as AmazonSpListingRow[];
  const passports = (passportsResult.data ?? []) as ProductPassportRow[];
  const economics = ((economicsResult.data ?? []) as ProductEconomicsRow[]).map(toSafeProductEconomicsRow);
  const listingBySku = new Map<string, AmazonSpListingRow>();
  const listingByAsin = new Map<string, AmazonSpListingRow[]>();
  const passportBySku = new Map<string, ProductPassportRow>();
  const passportByAsin = new Map<string, ProductPassportRow[]>();
  const economicsBySku = new Map<string, SafeProductEconomicsRow>();
  const economicsByAsin = new Map<string, SafeProductEconomicsRow[]>();

  for (const listing of listings) {
    setFirstByKey(listingBySku, normalizeKey(listing.sku), listing);
    pushByKey(listingByAsin, normalizeKey(listing.asin), listing);
  }

  for (const passport of passports) {
    setFirstByKey(passportBySku, normalizeKey(passport.sku), passport);
    pushByKey(passportByAsin, normalizeKey(passport.asin), passport);
  }

  for (const row of economics) {
    setFirstByKey(economicsBySku, normalizeKey(row.sku), row);
    pushByKey(economicsByAsin, normalizeKey(row.asin), row);
  }

  return {
    sellerId,
    listings,
    passports,
    economics,
    listingBySku,
    listingByAsin,
    passportBySku,
    passportByAsin,
    economicsBySku,
    economicsByAsin
  };
}

function buildRowsFromContext(context: CostCompletionContext): ProductPassportCostCompletionRow[] {
  const rows = new Map<string, ProductPassportCostCompletionRow>();

  for (const listing of context.listings) {
    const key = productKey(listing.sku, listing.asin);
    if (!key || rows.has(key)) continue;
    const skuKey = normalizeKey(listing.sku);
    const asinKey = normalizeKey(listing.asin);
    rows.set(key, buildCompletionRow({
      sellerId: context.sellerId,
      sku: listing.sku,
      asin: listing.asin,
      listing,
      passport: (skuKey ? context.passportBySku.get(skuKey) : undefined) ?? (asinKey ? context.passportByAsin.get(asinKey)?.[0] : undefined) ?? null,
      economics: (skuKey ? context.economicsBySku.get(skuKey) : undefined) ?? (asinKey ? context.economicsByAsin.get(asinKey)?.[0] : undefined) ?? null
    }));
  }

  for (const passport of context.passports) {
    const key = productKey(passport.sku, passport.asin);
    if (!key || rows.has(key)) continue;
    const skuKey = normalizeKey(passport.sku);
    const asinKey = normalizeKey(passport.asin);
    rows.set(key, buildCompletionRow({
      sellerId: context.sellerId,
      sku: passport.sku,
      asin: passport.asin,
      listing: (skuKey ? context.listingBySku.get(skuKey) : undefined) ?? (asinKey ? context.listingByAsin.get(asinKey)?.[0] : undefined) ?? null,
      passport,
      economics: (skuKey ? context.economicsBySku.get(skuKey) : undefined) ?? (asinKey ? context.economicsByAsin.get(asinKey)?.[0] : undefined) ?? null
    }));
  }

  for (const economics of context.economics) {
    const key = productKey(economics.sku, economics.asin);
    if (!key || rows.has(key)) continue;
    const skuKey = normalizeKey(economics.sku);
    const asinKey = normalizeKey(economics.asin);
    rows.set(key, buildCompletionRow({
      sellerId: context.sellerId,
      sku: economics.sku,
      asin: economics.asin,
      listing: (skuKey ? context.listingBySku.get(skuKey) : undefined) ?? (asinKey ? context.listingByAsin.get(asinKey)?.[0] : undefined) ?? null,
      passport: (skuKey ? context.passportBySku.get(skuKey) : undefined) ?? (asinKey ? context.passportByAsin.get(asinKey)?.[0] : undefined) ?? null,
      economics
    }));
  }

  const statusOrder: Record<ProductPassportCostStatus, number> = {
    INCOMPLETE: 0,
    PARTIAL: 1,
    COMPLETE: 2
  };

  return Array.from(rows.values()).sort((a, b) => {
    return statusOrder[a.costStatus] - statusOrder[b.costStatus] || (a.productName ?? a.sku ?? "").localeCompare(b.productName ?? b.sku ?? "");
  });
}

export async function listProductPassportCostCompletionRows(input: {
  sellerId: string;
  limit?: number;
  status?: ProductPassportCostStatus | "ALL";
  onlyNeedingCompletion?: boolean;
}): Promise<ProductPassportCostCompletionRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const context = await loadCostCompletionContext(input.sellerId, 1000);
  const rows = buildRowsFromContext(context);
  const filteredRows = input.status && input.status !== "ALL"
    ? input.status === "INCOMPLETE"
      ? rows.filter((row) => row.costStatus === "INCOMPLETE" || row.costStatus === "PARTIAL")
      : rows.filter((row) => row.costStatus === input.status)
    : input.onlyNeedingCompletion
    ? rows.filter((row) => row.costStatus !== "COMPLETE")
    : rows;
  const returnedRows = filteredRows.slice(0, limit);

  logger.info("Product Passport cost completion rows loaded.", {
    sellerId: context.sellerId,
    returnedCount: returnedRows.length,
    completeCount: returnedRows.filter((row) => row.costStatus === "COMPLETE").length,
    incompleteCount: returnedRows.filter((row) => row.costStatus === "INCOMPLETE").length
  });

  return returnedRows;
}

function uniqueSkusForAsin(context: CostCompletionContext, asin: string): string[] {
  const asinKey = normalizeKey(asin);
  if (!asinKey) return [];

  const skus = new Set<string>();
  for (const listing of context.listingByAsin.get(asinKey) ?? []) {
    const sku = cleanText(listing.sku);
    if (sku) skus.add(sku);
  }
  for (const passport of context.passportByAsin.get(asinKey) ?? []) {
    const sku = cleanText(passport.sku);
    if (sku) skus.add(sku);
  }
  for (const economics of context.economicsByAsin.get(asinKey) ?? []) {
    const sku = cleanText(economics.sku);
    if (sku) skus.add(sku);
  }

  return Array.from(skus);
}

function matchProductForBulkItem(context: CostCompletionContext, item: ProductPassportCostCompletionBulkItem): MatchedProduct | null {
  const inputSku = cleanText(item.sku);
  const inputAsin = cleanText(item.asin);
  let sku = inputSku;

  if (!sku && inputAsin) {
    const matchingSkus = uniqueSkusForAsin(context, inputAsin);
    if (matchingSkus.length !== 1) return null;
    sku = matchingSkus[0];
  }

  if (!sku) return null;

  const skuKey = normalizeKey(sku);
  const asinKey = normalizeKey(inputAsin);
  const listing = (skuKey ? context.listingBySku.get(skuKey) : undefined) ?? (asinKey ? context.listingByAsin.get(asinKey)?.[0] : undefined) ?? null;
  const passport = (skuKey ? context.passportBySku.get(skuKey) : undefined) ?? (asinKey ? context.passportByAsin.get(asinKey)?.[0] : undefined) ?? null;
  const economics = (skuKey ? context.economicsBySku.get(skuKey) : undefined) ?? (asinKey ? context.economicsByAsin.get(asinKey)?.[0] : undefined) ?? null;

  return {
    sku,
    asin: cleanText(inputAsin) ?? cleanText(economics?.asin) ?? cleanText(passport?.asin) ?? cleanText(listing?.asin),
    listing,
    passport,
    economics
  };
}

async function upsertProductPassportCostFields(input: {
  sellerId: string;
  match: MatchedProduct;
  item: ProductPassportCostCompletionBulkItem;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const productName =
    cleanText(input.match.economics?.productName) ??
    cleanText(input.match.passport?.product_name) ??
    cleanText(input.match.listing?.product_name) ??
    input.match.sku;
  const listingPrice = positiveNumber(input.match.listing?.price);
  const existingSellingPrice = positiveNumber(input.match.passport?.selling_price);
  const updateRow: Record<string, unknown> = {
    updated_at: now
  };
  const subcategory = cleanText(input.item.subcategory);
  const productCost = positiveNumber(input.item.productCost);

  if (input.match.passport) {
    if (!cleanText(input.match.passport.sku)) updateRow.sku = input.match.sku;
    if (!cleanText(input.match.passport.asin) && input.match.asin) updateRow.asin = input.match.asin;
    if (!cleanText(input.match.passport.product_name) && productName) updateRow.product_name = productName;
    if (subcategory) {
      updateRow.sub_category = subcategory;
      if (!cleanText(input.match.passport.category)) updateRow.category = subcategory;
    }
    if (!existingSellingPrice && listingPrice) updateRow.selling_price = listingPrice;
    if (productCost !== null) updateRow.supplier_cost = productCost;

    const keys = Object.keys(updateRow);
    if (keys.length <= 1) return false;

    const { error } = await supabase
      .from("product_passports")
      .update(updateRow)
      .eq("id", input.match.passport.id);

    if (error) {
      logger.warn("Could not update product passport cost fields.", {
        sellerId: input.sellerId,
        sku: input.match.sku,
        message: error.message
      });
      throw new Error("Could not update product passport cost fields.");
    }

    return true;
  }

  const insertRow = {
    seller_id: input.sellerId,
    sku: input.match.sku,
    asin: input.match.asin,
    product_name: productName,
    category: subcategory ?? cleanText(input.match.listing?.product_type),
    sub_category: subcategory,
    product_type: cleanText(input.match.listing?.product_type),
    selling_price: listingPrice,
    supplier_cost: productCost,
    status: "NEEDS_REVIEW"
  };

  const { error } = await supabase
    .from("product_passports")
    .insert(insertRow);

  if (error) {
    logger.warn("Could not create product passport for cost completion.", {
      sellerId: input.sellerId,
      sku: input.match.sku,
      message: error.message
    });
    throw new Error("Could not create product passport for cost completion.");
  }

  return true;
}

async function saveMergedEconomics(input: {
  sellerId: string;
  match: MatchedProduct;
  item: ProductPassportCostCompletionBulkItem;
}): Promise<boolean> {
  const item = input.item;
  const match = input.match;
  const economics = match.economics;
  const passport = match.passport;
  const listing = match.listing;
  const subcategory =
    cleanText(item.subcategory) ??
    noteValue(economics?.notes, "Subcategory") ??
    cleanText(passport?.sub_category) ??
    cleanText(passport?.category) ??
    cleanText(listing?.product_type);
  const productType =
    noteValue(economics?.notes, "Product Type") ??
    cleanText(passport?.product_type) ??
    cleanText(listing?.product_type) ??
    subcategory;
  const fulfillmentType =
    noteValue(economics?.notes, "Fulfillment Type") ??
    cleanText(listing?.fulfillment_channel);
  const sellingPrice =
    positiveNumber(economics?.sellingPrice) ??
    positiveNumber(passport?.selling_price) ??
    positiveNumber(listing?.price) ??
    0;
  const landedCost =
    positiveNumber(item.landedCost) ??
    positiveNumber(item.productCost) ??
    positiveNumber(economics?.landedCost) ??
    positiveNumber(passport?.supplier_cost) ??
    0;
  const packagingCost =
    toNumberOrNull(item.packagingCost) ??
    toNumberOrNull(economics?.packagingCost) ??
    0;
  const shippingFeeEstimate =
    toNumberOrNull(item.shippingCost) ??
    toNumberOrNull(economics?.shippingFeeEstimate) ??
    0;
  const manualOtherCost =
    toNumberOrNull(item.otherCost) ??
    noteNumber(economics?.notes, "Manual Other Fees") ??
    toNumberOrNull(economics?.otherCostPerUnit) ??
    0;
  const requiredProfit =
    positiveNumber(item.requiredProfit) ??
    positiveNumber(economics?.requiredProfit) ??
    0;
  const hasAnyEconomicsInput =
    item.productCost !== undefined ||
    item.landedCost !== undefined ||
    item.packagingCost !== undefined ||
    item.shippingCost !== undefined ||
    item.otherCost !== undefined ||
    item.requiredProfit !== undefined ||
    item.subcategory !== undefined;

  if (!hasAnyEconomicsInput && !economics) return false;

  await saveProductEconomics({
    sellerId: input.sellerId,
    marketplaceId: cleanText((listing as AmazonSpListingRow | null)?.marketplace_id),
    sku: match.sku,
    asin: match.asin,
    productName:
      cleanText(economics?.productName) ??
      cleanText(passport?.product_name) ??
      cleanText(listing?.product_name) ??
      match.sku,
    subCategory: subcategory,
    subcategoryOverride: subcategory,
    fulfillmentType,
    productType,
    shippingRegion: "National",
    categoryException: false,
    weightKg: noteNumber(economics?.notes, "Weight kg") ?? parseWeightKg(passport?.weight) ?? 0,
    volumeCuFt: noteNumber(economics?.notes, "Volume cu ft") ?? 0,
    hiddenOtherFee: economics?.hiddenOtherFee ?? 10,
    productGstRatePercent: economics?.productGstRatePercent ?? 18,
    amazonFeeGstRatePercent: economics?.amazonFeeGstRatePercent ?? 18,
    minimumApprovedProfit: requiredProfit,
    profitFlexEnabled: economics?.profitFlexEnabled ?? false,
    sellingPrice,
    landedCost,
    packagingCost,
    amazonFeeEstimate: economics?.amazonFeeEstimate ?? 0,
    shippingFeeEstimate,
    taxEstimate: economics?.taxEstimate ?? 0,
    returnRatePercent: economics?.returnRatePercent ?? 10,
    returnCostPerReturn: economics?.returnCostPerReturn ?? 0,
    influencerCostAllocationPerUnit: economics?.influencerCostAllocationPerUnit ?? 0,
    socialMarketingCostPerUnit: economics?.socialMarketingCostPerUnit ?? 0,
    couponDiscountEstimate: economics?.couponDiscountEstimate ?? 0,
    otherCostPerUnit: manualOtherCost,
    targetProfit: requiredProfit,
    preserveMissingRequiredProfit: requiredProfit <= 0,
    notes: null
  });

  return true;
}

export async function bulkUpdateProductPassportCostCompletion(input: {
  sellerId: string;
  items: ProductPassportCostCompletionBulkItem[];
  autoResolveActions?: boolean;
}): Promise<ProductPassportCostCompletionBulkResult> {
  const sellerId = cleanText(input.sellerId) ?? DEFAULT_SELLER_ID;
  const context = await loadCostCompletionContext(sellerId, 1000);
  const updatedSkus = new Set<string>();
  let updatedCount = 0;
  let skippedCount = 0;

  for (const item of input.items) {
    const match = matchProductForBulkItem(context, item);

    if (!match) {
      skippedCount += 1;
      continue;
    }

    const passportChanged = await upsertProductPassportCostFields({ sellerId, match, item });
    const economicsChanged = await saveMergedEconomics({ sellerId, match, item });

    if (passportChanged || economicsChanged) {
      updatedCount += 1;
      updatedSkus.add(match.sku);
    } else {
      skippedCount += 1;
    }
  }

  const refreshedContext = await loadCostCompletionContext(sellerId, 1000);
  const refreshedRows = buildRowsFromContext(refreshedContext);
  const rows = refreshedRows.filter((row) => row.sku && updatedSkus.has(row.sku));
  const resolvedActions = input.autoResolveActions
    ? await Promise.all(
      rows
        .filter((row) => row.costStatus === "COMPLETE")
        .map((row) => resolveProductPassportCostActions({ sellerId, sku: row.sku ?? "" }))
    )
    : undefined;

  return {
    ok: true,
    sellerId,
    requestedCount: input.items.length,
    updatedCount,
    skippedCount,
    rows,
    resolvedActions
  };
}

export async function resolveProductPassportCostActions(input: {
  sellerId: string;
  sku: string;
}): Promise<ProductPassportResolveActionsResult> {
  const sellerId = cleanText(input.sellerId) ?? DEFAULT_SELLER_ID;
  const sku = cleanText(input.sku);

  if (!sku) {
    return {
      ok: true,
      sellerId,
      sku: "",
      costStatus: null,
      eligible: false,
      updatedCount: 0,
      skippedCount: 0,
      rows: [],
      message: "SKU is required to resolve cost-data actions."
    };
  }

  const context = await loadCostCompletionContext(sellerId, 1000);
  const row = buildRowsFromContext(context).find((item) => item.sku === sku) ?? null;
  const eligible = row?.costStatus === "COMPLETE" || row?.costStatus === "PARTIAL";

  if (!eligible) {
    return {
      ok: true,
      sellerId,
      sku,
      costStatus: row?.costStatus ?? null,
      eligible: false,
      updatedCount: 0,
      skippedCount: 0,
      rows: [],
      message: "SKU cost data is not complete enough to resolve COST_DATA_REQUIRED actions."
    };
  }

  const { data: pendingRows, error: listError } = await supabase
    .from("action_ledger")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("sku", sku)
    .in("source", ["PRODUCT_ECONOMICS", "CEO_REPORT"])
    .eq("action_type", "COST_DATA_REQUIRED")
    .eq("approval_status", "PENDING");

  if (listError) {
    logger.warn("Could not load pending cost-data action ledger rows.", {
      sellerId,
      sku,
      message: listError.message
    });
    throw new Error("Could not load pending cost-data action ledger rows.");
  }

  const ids = ((pendingRows ?? []) as ActionLedgerRow[]).map((actionRow) => actionRow.id);

  if (!ids.length) {
    return {
      ok: true,
      sellerId,
      sku,
      costStatus: row.costStatus,
      eligible: true,
      updatedCount: 0,
      skippedCount: 0,
      rows: []
    };
  }

  const { data, error } = await supabase
    .from("action_ledger")
    .update({
      approval_status: "COMPLETED",
      state: "COMPLETED",
      approval_note: ACTION_RESOLVED_NOTE,
      updated_at: new Date().toISOString()
    })
    .eq("seller_id", sellerId)
    .eq("sku", sku)
    .in("id", ids)
    .in("source", ["PRODUCT_ECONOMICS", "CEO_REPORT"])
    .eq("action_type", "COST_DATA_REQUIRED")
    .eq("approval_status", "PENDING")
    .select("*");

  if (error) {
    logger.warn("Could not resolve cost-data action ledger rows.", {
      sellerId,
      sku,
      message: error.message
    });
    throw new Error("Could not resolve cost-data action ledger rows.");
  }

  const rows = ((data ?? []) as ActionLedgerRow[]).map(toSafeActionLedgerRow);

  return {
    ok: true,
    sellerId,
    sku,
    costStatus: row.costStatus,
    eligible: true,
    updatedCount: rows.length,
    skippedCount: Math.max(ids.length - rows.length, 0),
    rows: rows as SafeActionLedgerRow[]
  };
}

export async function getProductPassportCostCompletionSummary(sellerIdInput: string): Promise<ProductPassportCostCompletionSummary> {
  const sellerId = cleanText(sellerIdInput) ?? DEFAULT_SELLER_ID;
  const context = await loadCostCompletionContext(sellerId, 1000);
  const rows = buildRowsFromContext(context);
  const { count, error } = await supabase
    .from("action_ledger")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .in("source", ["PRODUCT_ECONOMICS", "CEO_REPORT"])
    .eq("action_type", "COST_DATA_REQUIRED")
    .eq("approval_status", "PENDING");

  if (error) {
    logger.warn("Could not count pending cost-data actions.", {
      sellerId,
      message: error.message
    });
    throw new Error("Could not count pending cost-data action ledger rows.");
  }

  return {
    ok: true,
    sellerId,
    totalSkus: rows.length,
    completeCount: rows.filter((row) => row.costStatus === "COMPLETE").length,
    incompleteCount: rows.filter((row) => row.costStatus === "INCOMPLETE").length,
    partialCount: rows.filter((row) => row.costStatus === "PARTIAL").length,
    missingCostCount: rows.filter((row) => row.missingFields.includes("productCost")).length,
    missingRequiredProfitCount: rows.filter((row) => row.missingFields.includes("requiredProfit")).length,
    missingSubcategoryCount: rows.filter((row) => row.missingFields.includes("subcategory")).length,
    pendingCostActionCount: count ?? 0
  };
}
