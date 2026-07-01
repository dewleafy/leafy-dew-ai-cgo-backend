import { supabase } from "../../db/supabase";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import {
  CostCompletionQueueRow,
  CostCompletionStatus,
  ProductEconomicsCalculation,
  ProductEconomicsExplanation,
  ProductEconomicsInput,
  ProductEconomicsRow,
  ProductProfitStatus,
  SafeProductEconomicsRow
} from "./product-economics.types";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { ProductPassportRow } from "../product-passports/product-passports.types";

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeKey(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function noteValue(notes: string | null | undefined, label: string): string | null {
  if (!notes) return null;
  const match = notes.match(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im"));
  return cleanText(match?.[1]);
}

function parseWeightKg(weight: string | null | undefined): number {
  const match = weight?.match(/(\d+(?:\.\d+)?)/);
  return match ? toNumber(match[1]) : 0;
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

function getProfitReason(status: ProductProfitStatus): string {
  if (status === "NEEDS_COST_DATA" || status === "BLOCKED") {
    return status === "BLOCKED"
      ? "Costs and required profit leave no room for PPC spend."
      : "Product cost data is missing, so profit-safe decisions are blocked.";
  }

  if (status === "PASS") {
    return "This product has enough ad room while protecting required net profit.";
  }

  if (status === "RISK") {
    return "Product can meet profit floor, but ad room is very low.";
  }

  if (status === "FAIL") {
    return "Product cannot meet required net profit after non-ad costs. Fix price, cost, bundle, or charges before ads.";
  }

  return "Product economics have not been calculated yet.";
}

function getTargetProfit(input: ProductEconomicsInput): { targetProfit: number; targetProfitRule: string } {
  const sellingPrice = toNumber(input.sellingPrice);
  const providedTargetProfit = Math.max(toNumber(input.targetProfit), 0);

  if (providedTargetProfit > 0) {
    return {
      targetProfit: roundTwo(providedTargetProfit),
      targetProfitRule: "PROVIDED_TARGET_PROFIT"
    };
  }

  if (sellingPrice <= 299) {
    return {
      targetProfit: roundTwo(Math.max(providedTargetProfit, 60)),
      targetProfitRule: "MIN_PROFIT_60_FOR_PRICE_UP_TO_299"
    };
  }

  if (sellingPrice >= 300 && sellingPrice <= 499) {
    return {
      targetProfit: roundTwo(Math.max(providedTargetProfit, 110)),
      targetProfitRule: "MIN_PROFIT_110_FOR_PRICE_300_TO_499"
    };
  }

  return {
    targetProfit: roundTwo(sellingPrice * 0.25),
    targetProfitRule: "DEFAULT_25_PERCENT_OF_SELLING_PRICE"
  };
}

export function calculateProductEconomics(input: ProductEconomicsInput): ProductEconomicsCalculation {
  const sellingPrice = toNumber(input.sellingPrice);
  const { targetProfit, targetProfitRule } = getTargetProfit(input);
  const hasMissingCostBasis =
    sellingPrice <= 0 ||
    toNumber(input.landedCost) <= 0;
  const providedReturnReserve = toNumber(input.returnReservePerUnit);
  const returnReservePerUnit =
    providedReturnReserve > 0
      ? providedReturnReserve
      : (toNumber(input.returnRatePercent) / 100) * toNumber(input.returnCostPerReturn);
  const nonAdCost =
    toNumber(input.landedCost) +
    toNumber(input.packagingCost) +
    toNumber(input.amazonFeeEstimate) +
    toNumber(input.shippingFeeEstimate) +
    toNumber(input.taxEstimate) +
    returnReservePerUnit +
    toNumber(input.influencerCostAllocationPerUnit) +
    toNumber(input.socialMarketingCostPerUnit) +
    toNumber(input.couponDiscountEstimate) +
    toNumber(input.otherCostPerUnit);
  const maxAllowableAdSpend = sellingPrice - nonAdCost - targetProfit;
  const breakEvenAcos = sellingPrice > 0 ? ((sellingPrice - nonAdCost) / sellingPrice) * 100 : 0;
  const targetAcos = sellingPrice > 0 ? (maxAllowableAdSpend / sellingPrice) * 100 : 0;
  const profitStatus: ProductProfitStatus =
    hasMissingCostBasis ? "NEEDS_COST_DATA" : maxAllowableAdSpend <= 0 ? "BLOCKED" : "PASS";
  const reason = getProfitReason(profitStatus);

  return {
    targetProfit,
    targetProfitRule,
    returnReservePerUnit: roundTwo(returnReservePerUnit),
    nonAdCost: roundTwo(nonAdCost),
    maxAllowableAdSpend: hasMissingCostBasis ? null : roundTwo(maxAllowableAdSpend),
    breakEvenAcos: hasMissingCostBasis ? null : roundTwo(breakEvenAcos),
    targetAcos: hasMissingCostBasis ? null : roundTwo(targetAcos),
    profitStatus,
    profitDataStatus: hasMissingCostBasis ? "MISSING_COST_DATA" : "AVAILABLE",
    reason
  };
}

function hasMissingCostData(row: ProductEconomicsRow | SafeProductEconomicsRow): boolean {
  const sellingPrice = "selling_price" in row ? row.selling_price : row.sellingPrice;
  const landedCost = "landed_cost" in row ? row.landed_cost : row.landedCost;

  return toNumber(sellingPrice) <= 0 || toNumber(landedCost) <= 0;
}

export function toSafeProductEconomicsRow(row: ProductEconomicsRow): SafeProductEconomicsRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    marketplaceId: row.marketplace_id,
    asin: row.asin,
    sku: row.sku,
    productName: row.product_name,
    sellingPrice: toNumber(row.selling_price),
    buyingCost: toNumber(row.landed_cost),
    landedCost: toNumber(row.landed_cost),
    packagingCost: toNumber(row.packaging_cost),
    shippingCost: toNumber(row.shipping_fee_estimate),
    referralFee: toNumber(row.amazon_fee_estimate),
    closingFee: toNumber(row.other_cost_per_unit),
    amazonFeeEstimate: toNumber(row.amazon_fee_estimate),
    shippingFeeEstimate: toNumber(row.shipping_fee_estimate),
    taxEstimate: toNumber(row.tax_estimate),
    returnRatePercent: toNumber(row.return_rate_percent),
    returnCostPerReturn: toNumber(row.return_cost_per_return),
    returnReservePerUnit: toNumber(row.return_reserve_per_unit),
    influencerCostAllocationPerUnit: toNumber(row.influencer_cost_allocation_per_unit),
    socialMarketingCostPerUnit: toNumber(row.social_marketing_cost_per_unit),
    couponDiscountEstimate: toNumber(row.coupon_discount_estimate),
    otherCostPerUnit: toNumber(row.other_cost_per_unit),
    requiredProfit: toNumber(row.target_profit),
    targetProfit: toNumber(row.target_profit),
    targetProfitRule: row.target_profit_rule,
    nonAdCost: toNumber(row.non_ad_cost),
    maxAllowableAdSpend: hasMissingCostData(row) ? null : toNumber(row.max_allowable_ad_spend),
    breakEvenAcos: hasMissingCostData(row) ? null : toNumber(row.break_even_acos),
    targetAcos: hasMissingCostData(row) ? null : toNumber(row.target_acos),
    profitStatus: hasMissingCostData(row) ? "NEEDS_COST_DATA" : row.profit_status,
    profitDataStatus: hasMissingCostData(row) ? "MISSING_COST_DATA" : "AVAILABLE",
    reason: hasMissingCostData(row) ? getProfitReason("NEEDS_COST_DATA") : getProfitReason(row.profit_status),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function buildProductEconomicsExplanation(
  row: SafeProductEconomicsRow
): ProductEconomicsExplanation {
  return {
    profitStatus: row.profitStatus,
    profitDataStatus: row.profitDataStatus,
    targetProfit: row.targetProfit,
    nonAdCost: row.nonAdCost,
    maxAllowableAdSpend: row.maxAllowableAdSpend,
    breakEvenAcos: row.breakEvenAcos,
    targetAcos: row.targetAcos,
    reason: row.reason
  };
}

export async function saveProductEconomics(input: ProductEconomicsInput): Promise<SafeProductEconomicsRow> {
  const calculation = calculateProductEconomics(input);
  const now = new Date().toISOString();
  const upsertRow = {
    seller_id: cleanText(input.sellerId) ?? "default",
    marketplace_id: cleanText(input.marketplaceId),
    asin: cleanText(input.asin),
    sku: cleanText(input.sku),
    product_name: cleanText(input.productName),
    selling_price: roundTwo(input.sellingPrice),
    landed_cost: roundTwo(input.landedCost),
    packaging_cost: roundTwo(input.packagingCost),
    amazon_fee_estimate: roundTwo(input.amazonFeeEstimate),
    shipping_fee_estimate: roundTwo(input.shippingFeeEstimate),
    tax_estimate: roundTwo(input.taxEstimate),
    return_rate_percent: roundTwo(input.returnRatePercent),
    return_cost_per_return: roundTwo(input.returnCostPerReturn),
    return_reserve_per_unit: calculation.returnReservePerUnit,
    influencer_cost_allocation_per_unit: roundTwo(input.influencerCostAllocationPerUnit),
    social_marketing_cost_per_unit: roundTwo(input.socialMarketingCostPerUnit),
    coupon_discount_estimate: roundTwo(input.couponDiscountEstimate),
    other_cost_per_unit: roundTwo(input.otherCostPerUnit),
    target_profit: calculation.targetProfit,
    target_profit_rule: calculation.targetProfitRule,
    non_ad_cost: calculation.nonAdCost,
    max_allowable_ad_spend: calculation.maxAllowableAdSpend,
    break_even_acos: calculation.breakEvenAcos,
    target_acos: calculation.targetAcos,
    profit_status: calculation.profitStatus,
    notes: cleanText(input.notes),
    updated_at: now
  };

  const sellerId = cleanText(input.sellerId) ?? "default";
  const sku = cleanText(input.sku);
  let existingId: string | null = null;

  if (sku) {
    const { data: existing, error: loadError } = await supabase
      .from("amazon_product_economics")
      .select("id")
      .eq("seller_id", sellerId)
      .eq("sku", sku)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (loadError) {
      logger.warn("Could not load existing product economics row.", {
        message: sanitizeErrorMessage(loadError.message)
      });
      throw new Error("Could not save product economics in Supabase.");
    }

    existingId = existing?.id ?? null;
  }

  const query = existingId
    ? supabase.from("amazon_product_economics").update(upsertRow).eq("id", existingId)
    : supabase.from("amazon_product_economics").insert(upsertRow);

  const { data, error } = await query
    .select("*")
    .single<ProductEconomicsRow>();

  if (error || !data) {
    logger.warn("Could not save product economics row.", {
      message: error?.message ? sanitizeErrorMessage(error.message) : "No row returned"
    });
    throw new Error("Could not save product economics in Supabase.");
  }

  return toSafeProductEconomicsRow(data);
}

export async function listProductEconomics(sellerId: string): Promise<SafeProductEconomicsRow[]> {
  const { data, error } = await supabase
    .from("amazon_product_economics")
    .select("*")
    .eq("seller_id", cleanText(sellerId) ?? "default")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    logger.warn("Could not list product economics rows.", {
      message: sanitizeErrorMessage(error.message)
    });
    throw new Error("Could not load product economics from Supabase.");
  }

  return ((data ?? []) as ProductEconomicsRow[]).map(toSafeProductEconomicsRow);
}

export async function getProductEconomicsById(id: string): Promise<SafeProductEconomicsRow | null> {
  const { data, error } = await supabase
    .from("amazon_product_economics")
    .select("*")
    .eq("id", id)
    .maybeSingle<ProductEconomicsRow>();

  if (error) {
    logger.warn("Could not load product economics row.", {
      message: sanitizeErrorMessage(error.message)
    });
    throw new Error("Could not load product economics from Supabase.");
  }

  return data ? toSafeProductEconomicsRow(data) : null;
}

export async function getCostCompletionQueue(sellerIdInput: string): Promise<CostCompletionQueueRow[]> {
  const sellerId = cleanText(sellerIdInput) ?? "default";

  const [listingsResult, passportsResult, economicsResult] = await Promise.all([
    supabase
      .from("amazon_sp_listings")
      .select("*")
      .eq("seller_id", sellerId)
      .order("last_synced_at", { ascending: false })
      .limit(500),
    supabase
      .from("product_passports")
      .select("*")
      .eq("seller_id", sellerId)
      .neq("status", "ARCHIVED")
      .limit(500),
    supabase
      .from("amazon_product_economics")
      .select("*")
      .eq("seller_id", sellerId)
      .order("created_at", { ascending: false })
      .limit(500)
  ]);

  if (listingsResult.error) {
    logger.warn("Could not load Amazon listings for cost completion queue.", {
      message: sanitizeErrorMessage(listingsResult.error.message)
    });
    throw new Error("Could not load cost completion queue from Supabase.");
  }

  if (passportsResult.error) {
    logger.warn("Could not load product passports for cost completion queue.", {
      message: sanitizeErrorMessage(passportsResult.error.message)
    });
    throw new Error("Could not load cost completion queue from Supabase.");
  }

  if (economicsResult.error) {
    logger.warn("Could not load product economics for cost completion queue.", {
      message: sanitizeErrorMessage(economicsResult.error.message)
    });
    throw new Error("Could not load cost completion queue from Supabase.");
  }

  const passports = (passportsResult.data ?? []) as ProductPassportRow[];
  const economicsRows = (economicsResult.data ?? []) as ProductEconomicsRow[];
  const safeEconomicsRows = economicsRows.map(toSafeProductEconomicsRow);
  const passportBySku = new Map(passports.map((row) => [normalizeKey(row.sku), row]).filter((entry): entry is [string, ProductPassportRow] => Boolean(entry[0])));
  const passportByAsin = new Map(passports.map((row) => [normalizeKey(row.asin), row]).filter((entry): entry is [string, ProductPassportRow] => Boolean(entry[0])));
  const economicsBySku = new Map(safeEconomicsRows.map((row) => [normalizeKey(row.sku), row]).filter((entry): entry is [string, SafeProductEconomicsRow] => Boolean(entry[0])));
  const economicsByAsin = new Map(safeEconomicsRows.map((row) => [normalizeKey(row.asin), row]).filter((entry): entry is [string, SafeProductEconomicsRow] => Boolean(entry[0])));
  const queue = new Map<string, CostCompletionQueueRow>();

  function buildQueueRow(input: {
    sku: string | null;
    asin: string | null;
    productName: string | null;
    listingPrice?: unknown;
    listingProductType?: string | null;
    listingFulfillmentType?: string | null;
  }): CostCompletionQueueRow | null {
    const skuKey = normalizeKey(input.sku);
    const asinKey = normalizeKey(input.asin);
    const key = skuKey ? `sku:${skuKey}` : asinKey ? `asin:${asinKey}` : null;
    if (!key) return null;

    const passport = (skuKey ? passportBySku.get(skuKey) : undefined) ?? (asinKey ? passportByAsin.get(asinKey) : undefined) ?? null;
    const existingEconomics = (skuKey ? economicsBySku.get(skuKey) : undefined) ?? (asinKey ? economicsByAsin.get(asinKey) : undefined) ?? null;
    const notes = existingEconomics?.notes ?? null;
    const noteSubcategory = noteValue(notes, "Subcategory");
    const subcategory = cleanText(passport?.sub_category) ?? noteSubcategory ?? cleanText(input.listingProductType);
    const subcategorySource: CostCompletionQueueRow["subcategorySource"] =
      cleanText(passport?.sub_category)
        ? "PRODUCT_PASSPORT"
        : noteSubcategory
          ? "ECONOMICS_NOTES"
          : cleanText(input.listingProductType)
            ? "AMAZON_LISTING"
            : "MISSING";
    const sellingPrice = existingEconomics?.sellingPrice || toNumber(passport?.selling_price) || toNumber(input.listingPrice) || null;
    const productCost = existingEconomics?.buyingCost ?? 0;
    const requiredProfit = existingEconomics?.requiredProfit ?? 0;
    const fulfillmentType = noteValue(notes, "Fulfillment Type") ?? cleanText(input.listingFulfillmentType);
    const productType = noteValue(notes, "Product Type") ?? cleanText(passport?.product_type) ?? cleanText(input.listingProductType);
    const weightKg = toNumber(noteValue(notes, "Weight kg")) || parseWeightKg(passport?.weight);
    const missingFields: string[] = [];

    if (!existingEconomics || productCost <= 0) missingFields.push("productCost");
    if (!existingEconomics || requiredProfit <= 0) missingFields.push("requiredProfit");
    if (!fulfillmentType) missingFields.push("fulfillmentType");
    if (!productType) missingFields.push("productType");
    if (weightKg <= 0) missingFields.push("weightKg");

    let costStatus: CostCompletionStatus = "INCOMPLETE";
    let nextActionLabel = "Complete missing inputs";

    if (!existingEconomics || productCost <= 0) {
      costStatus = "MISSING_COST_DATA";
      nextActionLabel = "Add buying cost";
    } else if (weightKg <= 0) {
      costStatus = "INCOMPLETE";
      nextActionLabel = "Add weight";
    } else if (requiredProfit <= 0 || !fulfillmentType || !productType) {
      costStatus = "INCOMPLETE";
      nextActionLabel = requiredProfit <= 0 ? "Add required profit" : "Complete fee inputs";
    } else if ((existingEconomics.maxAllowableAdSpend ?? 0) <= 0 || existingEconomics.profitStatus === "BLOCKED") {
      costStatus = "BLOCKED";
      nextActionLabel = "Blocked: no ad spend room";
    } else if (existingEconomics.profitStatus === "PASS") {
      costStatus = "COMPLETE";
      nextActionLabel = "Ready for profit-safe PPC";
    }

    return {
      sku: cleanText(input.sku),
      asin: cleanText(input.asin),
      productName: cleanText(input.productName) ?? existingEconomics?.productName ?? passport?.product_name ?? null,
      subcategory,
      subCategory: subcategory,
      subcategorySource,
      sellingPrice,
      costStatus,
      profitStatus: existingEconomics?.profitStatus ?? null,
      profitDataStatus: existingEconomics?.profitDataStatus ?? (costStatus === "INCOMPLETE" ? "INCOMPLETE" : null),
      missingFields,
      targetAcos: existingEconomics?.targetAcos ?? null,
      breakEvenAcos: existingEconomics?.breakEvenAcos ?? null,
      existingEconomics,
      nextActionLabel
    };
  }

  ((listingsResult.data ?? []) as AmazonSpListingRow[]).forEach((listing) => {
    const row = buildQueueRow({
      sku: listing.sku,
      asin: listing.asin,
      productName: listing.product_name,
      listingPrice: listing.price,
      listingProductType: listing.product_type,
      listingFulfillmentType: listing.fulfillment_channel
    });

    if (row) queue.set(normalizeKey(row.sku) ? `sku:${normalizeKey(row.sku)}` : `asin:${normalizeKey(row.asin)}`, row);
  });

  passports.forEach((passport) => {
    const key = normalizeKey(passport.sku) ? `sku:${normalizeKey(passport.sku)}` : normalizeKey(passport.asin) ? `asin:${normalizeKey(passport.asin)}` : null;
    if (!key || queue.has(key)) return;
    const row = buildQueueRow({
      sku: passport.sku,
      asin: passport.asin,
      productName: passport.product_name,
      listingPrice: passport.selling_price,
      listingProductType: passport.product_type
    });
    if (row) queue.set(key, row);
  });

  safeEconomicsRows.forEach((economics) => {
    const key = normalizeKey(economics.sku) ? `sku:${normalizeKey(economics.sku)}` : normalizeKey(economics.asin) ? `asin:${normalizeKey(economics.asin)}` : null;
    if (!key || queue.has(key)) return;
    const row = buildQueueRow({
      sku: economics.sku,
      asin: economics.asin,
      productName: economics.productName,
      listingPrice: economics.sellingPrice
    });
    if (row) queue.set(key, row);
  });

  return Array.from(queue.values()).sort((a, b) => {
    const statusOrder: Record<CostCompletionStatus, number> = {
      MISSING_COST_DATA: 0,
      INCOMPLETE: 1,
      BLOCKED: 2,
      COMPLETE: 3
    };

    return statusOrder[a.costStatus] - statusOrder[b.costStatus] || (a.productName ?? a.sku ?? "").localeCompare(b.productName ?? b.sku ?? "");
  });
}
