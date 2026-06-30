import { supabase } from "../../db/supabase";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import {
  ProductEconomicsCalculation,
  ProductEconomicsExplanation,
  ProductEconomicsInput,
  ProductEconomicsRow,
  ProductProfitStatus,
  SafeProductEconomicsRow
} from "./product-economics.types";

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
