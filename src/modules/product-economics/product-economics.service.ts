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
  ProfitBand,
  ProfitBandApproval,
  ProductProfitStatus,
  SafeProductEconomicsRow
} from "./product-economics.types";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import { normalizeProductMedia } from "../product-media/product-media-normalizer";

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function floorTwo(value: number): number {
  return Math.floor(value * 100) / 100;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeKey(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, millis: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.millis))
    .sort((a, b) => b.millis - a.millis);

  return timestamps[0]?.value ?? null;
}

function noteValue(notes: string | null | undefined, label: string): string | null {
  if (!notes) return null;
  const match = notes.match(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im"));
  return cleanText(match?.[1]);
}

function noteNumber(notes: string | null | undefined, label: string): number {
  return toNumber(noteValue(notes, label));
}

function noteBoolean(notes: string | null | undefined, label: string): boolean {
  const value = noteValue(notes, label)?.toLowerCase();
  return value === "true" || value === "yes";
}

function parseWeightKg(weight: string | null | undefined): number {
  const match = weight?.match(/(\d+(?:\.\d+)?)/);
  return match ? toNumber(match[1]) : 0;
}

const FEE_RULES_VERSION = "amazon_fee_engine_v1_strict";

const referralFeeRules: Record<string, Array<{ maxPrice: number; percent: number }>> = {
  "home decor products": [{ maxPrice: 1000, percent: 0 }, { maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home - other products": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home improvement - other products": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home improvement - accessories": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home storage": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home furnishing": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home - fragrance & candles": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "kitchen - glassware & ceramicware": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "cookware, tableware & dinnerware": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "rugs and doormats": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "clocks": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "wall art": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "bedsheets, blankets and covers": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "containers, boxes, bottles": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "curtains and accessories": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "cushion covers": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "indoor lighting": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "indoor lighting - others": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "led bulbs and battens": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "wall paints and tools": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "craft materials": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "safes and lockers": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "mattresses": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 18 }]
};

function normalizeCategory(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function getReferralFee(input: ProductEconomicsInput, sellingPrice: number): {
  source: "REFERRAL_FEE_TABLE" | "MISSING_SUBCATEGORY" | "NO_MATCH";
  percent: number | null;
  amount: number;
} {
  const subcategory = normalizeCategory(input.subcategoryOverride ?? input.subCategory);
  if (!subcategory) return { source: "MISSING_SUBCATEGORY", percent: null, amount: 0 };

  const rules = referralFeeRules[subcategory];
  if (!rules) return { source: "NO_MATCH", percent: null, amount: 0 };

  const rule = rules.find((item) => sellingPrice <= item.maxPrice);
  if (!rule) return { source: "NO_MATCH", percent: null, amount: 0 };

  return {
    source: "REFERRAL_FEE_TABLE",
    percent: rule.percent,
    amount: roundTwo((sellingPrice * rule.percent) / 100)
  };
}

function getClosingFee(sellingPrice: number, categoryException?: boolean | null): number {
  if (categoryException) return 0;
  if (sellingPrice <= 250) return 5;
  if (sellingPrice <= 500) return 22;
  if (sellingPrice <= 1000) return 25;
  return 50;
}

function getShippingFee(input: ProductEconomicsInput): number {
  const manualShippingFee = toNumber(input.shippingFeeEstimate);

  if (manualShippingFee > 0) {
    return manualShippingFee;
  }

  const fulfillmentType = normalizeFulfillmentType(input.fulfillmentType);
  const weightKg = toNumber(input.weightKg);

  if (fulfillmentType === "self_ship") return 0;
  if (weightKg <= 0.5) return 50;
  if (weightKg <= 1) return 70;
  return 100;
}

function getPickAndPackFee(input: ProductEconomicsInput): number {
  if (normalizeFulfillmentType(input.fulfillmentType) !== "fc") return 0;
  return normalizeCategory(input.productType) === "oversize" ? 25 : 17;
}

function getStorageFee(input: ProductEconomicsInput): number {
  if (normalizeFulfillmentType(input.fulfillmentType) !== "fc") return 0;
  return roundTwo(toNumber(input.volumeCuFt) * 5);
}

function normalizeFulfillmentType(value: string | null | undefined): string | null {
  const normalized = cleanText(value)
    ?.toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  if (["fc", "fba", "amazon fulfilled"].includes(normalized)) return "fc";
  if (normalized === "easy ship") return "easy_ship";
  if (normalized === "easy ship prime") return "easy_ship_prime";
  if (normalized === "seller flex") return "seller_flex";
  if (normalized === "self ship") return "self_ship";
  return normalized.replace(/\s+/g, "_");
}

function getRiskLevel(index: number): ProfitBand["riskLevel"] {
  if (index === 0) return "LOW";
  if (index === 1) return "MEDIUM";
  if (index === 2) return "HIGH";
  return "VERY_HIGH";
}

function getApprovalTier(requiredProfit: number, minProfit: number, riskLevel: ProfitBand["riskLevel"]): ProfitBand["approvalTier"] {
  const dropPercent = requiredProfit > 0 ? ((requiredProfit - minProfit) / requiredProfit) * 100 : 0;
  if (dropPercent >= 40) return "FOUNDER_OVERRIDE_REQUIRED";
  if (dropPercent > 20 || riskLevel === "HIGH" || riskLevel === "VERY_HIGH") return "HIGH_RISK_APPROVAL";
  return "PROFIT_BAND_APPROVAL";
}

function getProfitBandWarning(requiredProfit: number, minProfit: number): string | null {
  const dropPercent = requiredProfit > 0 ? ((requiredProfit - minProfit) / requiredProfit) * 100 : 0;
  if (dropPercent >= 40) return "Suggested profit band is too far below target profit and requires founder override.";
  if (dropPercent > 20) return "Suggested profit band is significantly below target profit.";
  return null;
}

function buildProfitBands(input: {
  requiredProfit: number;
  sellingPrice: number;
  netProfitBeforeAds: number | null;
}): ProfitBand[] {
  const bands: ProfitBand[] = [];

  for (let index = 0; index < 5; index += 1) {
    const maxProfit = roundTwo(input.requiredProfit - index * 10);
    const minProfit = roundTwo(maxProfit - 10);
    if (maxProfit <= 0 || minProfit < 0) continue;

    const maxAllowableAdSpend = input.netProfitBeforeAds === null ? null : roundTwo(input.netProfitBeforeAds - minProfit);
    const targetAcos =
      input.netProfitBeforeAds === null || input.sellingPrice <= 0
        ? null
        : floorTwo(((input.netProfitBeforeAds - minProfit) / input.sellingPrice) * 100);
    const riskLevel = getRiskLevel(index);

    bands.push({
      bandLabel: `${minProfit}-${maxProfit}`,
      minProfit,
      maxProfit,
      targetAcos,
      maxAllowableAdSpend,
      riskLevel,
      approvalRequired: true,
      approvalTier: getApprovalTier(input.requiredProfit, minProfit, riskLevel),
      warning: getProfitBandWarning(input.requiredProfit, minProfit)
    });
  }

  return bands;
}

function getRecommendedProfitBand(input: {
  sku: string | null;
  requiredProfit: number;
  profitStatus: ProductProfitStatus;
  bands: ProfitBand[];
}): {
  recommendedProfitBand: ProfitBand | null;
  recommendedProfitBandReason: string;
  approval: ProfitBandApproval | null;
} {
  if (input.profitStatus === "PASS") {
    return {
      recommendedProfitBand: null,
      recommendedProfitBandReason: "Required profit is protected.",
      approval: null
    };
  }

  const positiveBands = input.bands.filter((band) => (band.maxAllowableAdSpend ?? 0) > 0);
  const closestBand = positiveBands[0] ?? null;

  if (!closestBand) {
    return {
      recommendedProfitBand: null,
      recommendedProfitBandReason: "Do not scale. No profit band gives safe ad spend room.",
      approval: null
    };
  }

  if (closestBand.approvalTier === "FOUNDER_OVERRIDE_REQUIRED") {
    return {
      recommendedProfitBand: closestBand,
      recommendedProfitBandReason: "Do not scale. Profit drop is too high.",
      approval: {
        approvalType: "PROFIT_BAND_APPROVAL",
        sku: input.sku,
        currentRequiredProfit: input.requiredProfit,
        requestedProfitBand: closestBand,
        riskLevel: closestBand.riskLevel,
        reason: "Lower profit band requires founder override before PPC scaling.",
        expiresInDays: 7
      }
    };
  }

  return {
    recommendedProfitBand: closestBand,
    recommendedProfitBandReason: `Profit flex available, but requires approval for ${closestBand.bandLabel}.`,
    approval: {
      approvalType: "PROFIT_BAND_APPROVAL",
      sku: input.sku,
      currentRequiredProfit: input.requiredProfit,
      requestedProfitBand: closestBand,
      riskLevel: closestBand.riskLevel,
      reason: "Lower profit band must be approved before use.",
      expiresInDays: 7
    }
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value).replace(/\n/g, " ");
}

function parseNoteJson<T>(notes: string | null | undefined, label: string, fallback: T): T {
  const value = noteValue(notes, label);
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildCalculationNotes(input: ProductEconomicsInput, calculation: ProductEconomicsCalculation): string | null {
  const lines = [
    cleanText(input.notes),
    `Shipping Region: ${cleanText(input.shippingRegion) ?? "National"}`,
    `Category Exception: ${input.categoryException ? "Yes" : "No"}`,
    cleanText(input.fulfillmentType) ? `Fulfillment Type: ${cleanText(input.fulfillmentType)}` : "",
    cleanText(input.productType) ? `Product Type: ${cleanText(input.productType)}` : "",
    cleanText(input.subcategoryOverride ?? input.subCategory) ? `Subcategory: ${cleanText(input.subcategoryOverride ?? input.subCategory)}` : "",
    input.weightKg !== undefined ? `Weight kg: ${toNumber(input.weightKg)}` : "",
    input.volumeCuFt !== undefined ? `Volume cu ft: ${toNumber(input.volumeCuFt)}` : "",
    `Product GST Rate Percent: ${calculation.productGstRatePercent}`,
    `Amazon Fee GST Rate Percent: ${calculation.amazonFeeGstRatePercent}`,
    `Minimum Approved Profit: ${calculation.minimumApprovedProfit}`,
    `Profit Flex Enabled: ${calculation.profitFlexEnabled ? "Yes" : "No"}`,
    `Referral Fee Source: ${calculation.referralFeeSource}`,
    calculation.referralFeePercent !== null ? `Referral Fee Percent: ${calculation.referralFeePercent}` : "",
    `Referral Fee: ${calculation.referralFee}`,
    `Closing Fee: ${calculation.closingFee}`,
    `Shipping Fee: ${calculation.shippingFee}`,
    `Pick & Pack Fee: ${calculation.pickAndPackFee}`,
    `Storage Fee: ${calculation.storageFee}`,
    `Manual Other Fees: ${calculation.manualOtherFees}`,
    `Other Fees: ${calculation.otherFees}`,
    `Total Amazon Fees: ${calculation.totalAmazonFees}`,
    `GST on Amazon Fees: ${calculation.gstOnAmazonFees}`,
    calculation.netRevenueBeforeGst !== null ? `Net Revenue Before GST: ${calculation.netRevenueBeforeGst}` : "",
    calculation.outputGstOnSale !== null ? `Output GST On Sale: ${calculation.outputGstOnSale}` : "",
    `Return Cost Provision: ${calculation.returnCostProvision}`,
    `Hidden Other Fee: ${calculation.hiddenOtherFee}`,
    calculation.netProfitBeforeAds !== null ? `Net Profit Before Ads: ${calculation.netProfitBeforeAds}` : "",
    calculation.grossProfit !== null ? `Gross Profit: ${calculation.grossProfit}` : "",
    calculation.netProfit !== null ? `Net Profit: ${calculation.netProfit}` : "",
    calculation.profitMarginPercent !== null ? `Profit Margin Percent: ${calculation.profitMarginPercent}` : "",
    `Profit Bands: ${stringifyJson(calculation.profitBands)}`,
    calculation.recommendedProfitBand ? `Recommended Profit Band: ${stringifyJson(calculation.recommendedProfitBand)}` : "",
    `Recommended Profit Band Reason: ${calculation.recommendedProfitBandReason}`,
    calculation.approval ? `Profit Band Approval: ${stringifyJson(calculation.approval)}` : "",
    `Fee Rules Version: ${calculation.feeRulesVersion}`
  ].filter(Boolean);

  return lines.length ? lines.join("\n") : null;
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
  if (status === "NEEDS_INPUT") {
    return "Required fee inputs are missing, so profit-safe decisions are blocked.";
  }

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

  if (input.preserveMissingRequiredProfit && providedTargetProfit <= 0) {
    return {
      targetProfit: 0,
      targetProfitRule: "MISSING_REQUIRED_PROFIT"
    };
  }

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
  const productCost = toNumber(input.landedCost);
  const { targetProfit, targetProfitRule } = getTargetProfit(input);
  const productGstRatePercent = toNumber(input.productGstRatePercent ?? 18);
  const amazonFeeGstRatePercent = toNumber(input.amazonFeeGstRatePercent ?? 18);
  const returnRatePercent = toNumber(input.returnRatePercent ?? 10);
  const minimumApprovedProfit = toNumber(input.minimumApprovedProfit ?? targetProfit);
  const profitFlexEnabled = Boolean(input.profitFlexEnabled);
  const referralFee = getReferralFee(input, sellingPrice);
  const closingFee = getClosingFee(sellingPrice, input.categoryException);
  const shippingFee = getShippingFee(input);
  const pickAndPackFee = getPickAndPackFee(input);
  const storageFee = getStorageFee(input);
  const manualOtherFees = toNumber(input.otherFees ?? input.otherCostPerUnit);
  const hiddenOtherFee = toNumber(input.hiddenOtherFee ?? 10);
  const otherFees = roundTwo(manualOtherFees + hiddenOtherFee);
  const totalAmazonFees = roundTwo(referralFee.amount + closingFee + shippingFee + pickAndPackFee + storageFee + otherFees);
  const gstOnAmazonFees = roundTwo(totalAmazonFees * (amazonFeeGstRatePercent / 100));
  const netRevenueBeforeGst = sellingPrice > 0 ? roundTwo(sellingPrice / (1 + productGstRatePercent / 100)) : null;
  const outputGstOnSale = netRevenueBeforeGst === null ? null : roundTwo(sellingPrice - netRevenueBeforeGst);
  const hasMissingCostBasis =
    sellingPrice <= 0 ||
    productCost <= 0;
  const hasMissingRequiredProfit = input.preserveMissingRequiredProfit === true && targetProfit <= 0;
  const hasMissingSubcategory = referralFee.source === "MISSING_SUBCATEGORY";
  const hasReferralNoMatch = referralFee.source === "NO_MATCH";
  const returnReservePerUnit = roundTwo(sellingPrice * (returnRatePercent / 100));
  const netProfitBeforeAds =
    netRevenueBeforeGst === null
      ? null
      : roundTwo(netRevenueBeforeGst - productCost - totalAmazonFees - gstOnAmazonFees - returnReservePerUnit);
  const nonAdCost = roundTwo(productCost + totalAmazonFees + gstOnAmazonFees + returnReservePerUnit);
  const maxAllowableAdSpend = netProfitBeforeAds === null ? 0 : netProfitBeforeAds - targetProfit;
  const breakEvenAcos = sellingPrice > 0 && netProfitBeforeAds !== null ? (netProfitBeforeAds / sellingPrice) * 100 : 0;
  const targetAcos = sellingPrice > 0 && netProfitBeforeAds !== null ? (maxAllowableAdSpend / sellingPrice) * 100 : 0;
  const profitStatus: ProductProfitStatus =
    hasMissingSubcategory || hasReferralNoMatch
      ? "NEEDS_INPUT"
      : hasMissingCostBasis || hasMissingRequiredProfit
        ? "NEEDS_COST_DATA"
        : maxAllowableAdSpend <= 0
          ? "BLOCKED"
          : "PASS";
  const profitDataStatus =
    hasMissingSubcategory || hasReferralNoMatch
      ? "INCOMPLETE"
      : hasMissingCostBasis || hasMissingRequiredProfit
        ? "MISSING_COST_DATA"
        : "AVAILABLE";
  const reason = hasMissingSubcategory
    ? "Subcategory is missing, so referral fee cannot be calculated."
    : hasReferralNoMatch
      ? "Subcategory does not match the referral fee table, so referral fee cannot be calculated."
      : hasMissingRequiredProfit
        ? "Required profit is missing, so profit-safe decisions are blocked."
      : getProfitReason(profitStatus);
  const shouldBlockMetrics = hasMissingSubcategory || hasReferralNoMatch || hasMissingCostBasis || hasMissingRequiredProfit;
  const grossProfit = netRevenueBeforeGst !== null ? roundTwo(netRevenueBeforeGst - productCost - totalAmazonFees) : null;
  const netProfit = netProfitBeforeAds;
  const profitBands = buildProfitBands({
    requiredProfit: targetProfit,
    sellingPrice,
    netProfitBeforeAds: shouldBlockMetrics ? null : netProfitBeforeAds
  });
  const recommendation = getRecommendedProfitBand({
    sku: cleanText(input.sku),
    requiredProfit: targetProfit,
    profitStatus,
    bands: profitBands
  });

  return {
    targetProfit,
    targetProfitRule,
    returnReservePerUnit: roundTwo(returnReservePerUnit),
    nonAdCost: roundTwo(nonAdCost),
    maxAllowableAdSpend: shouldBlockMetrics ? null : roundTwo(maxAllowableAdSpend),
    breakEvenAcos: shouldBlockMetrics ? null : roundTwo(breakEvenAcos),
    targetAcos: shouldBlockMetrics ? null : floorTwo(targetAcos),
    profitStatus,
    profitDataStatus,
    referralFeeSource: referralFee.source,
    referralFeePercent: referralFee.percent,
    referralFee: referralFee.amount,
    closingFee,
    shippingFee,
    pickAndPackFee,
    storageFee,
    manualOtherFees,
    otherFees,
    totalAmazonFees,
    gstOnAmazonFees,
    grossProfit,
    netProfit,
    profitMarginPercent: netProfit !== null && sellingPrice > 0 ? roundTwo((netProfit / sellingPrice) * 100) : null,
    productGstRatePercent,
    amazonFeeGstRatePercent,
    netRevenueBeforeGst,
    outputGstOnSale,
    returnCostProvision: roundTwo(returnReservePerUnit),
    hiddenOtherFee,
    netProfitBeforeAds,
    minimumApprovedProfit,
    profitFlexEnabled,
    profitBands,
    recommendedProfitBand: recommendation.recommendedProfitBand,
    recommendedProfitBandReason: recommendation.recommendedProfitBandReason,
    approval: recommendation.approval,
    feeRulesVersion: FEE_RULES_VERSION,
    reason
  };
}

export function getProductEconomicsFormulaCheckExample(): Pick<
  ProductEconomicsCalculation,
  | "netRevenueBeforeGst"
  | "outputGstOnSale"
  | "referralFeePercent"
  | "referralFee"
  | "closingFee"
  | "shippingFee"
  | "pickAndPackFee"
  | "storageFee"
  | "hiddenOtherFee"
  | "manualOtherFees"
  | "otherFees"
  | "totalAmazonFees"
  | "gstOnAmazonFees"
  | "returnCostProvision"
  | "netProfitBeforeAds"
  | "maxAllowableAdSpend"
  | "targetAcos"
  | "breakEvenAcos"
> {
  const calculation = calculateProductEconomics({
    sellerId: "default",
    sku: "FORMULA_CHECK",
    sellingPrice: 449,
    landedCost: 110,
    packagingCost: 0,
    amazonFeeEstimate: 0,
    shippingFeeEstimate: 0,
    taxEstimate: 0,
    returnRatePercent: 10,
    returnCostPerReturn: 0,
    influencerCostAllocationPerUnit: 0,
    socialMarketingCostPerUnit: 0,
    couponDiscountEstimate: 0,
    otherFees: 0,
    otherCostPerUnit: 0,
    targetProfit: 100,
    fulfillmentType: "Easy Ship Prime",
    productType: "Standard",
    weightKg: 0.5,
    volumeCuFt: 0.5,
    subcategoryOverride: "Home Decor Products",
    productGstRatePercent: 18,
    amazonFeeGstRatePercent: 18,
    hiddenOtherFee: 10,
    categoryException: false
  });

  return {
    netRevenueBeforeGst: calculation.netRevenueBeforeGst,
    outputGstOnSale: calculation.outputGstOnSale,
    referralFeePercent: calculation.referralFeePercent,
    referralFee: calculation.referralFee,
    closingFee: calculation.closingFee,
    shippingFee: calculation.shippingFee,
    pickAndPackFee: calculation.pickAndPackFee,
    storageFee: calculation.storageFee,
    hiddenOtherFee: calculation.hiddenOtherFee,
    manualOtherFees: calculation.manualOtherFees,
    otherFees: calculation.otherFees,
    totalAmazonFees: calculation.totalAmazonFees,
    gstOnAmazonFees: calculation.gstOnAmazonFees,
    returnCostProvision: calculation.returnCostProvision,
    netProfitBeforeAds: calculation.netProfitBeforeAds,
    maxAllowableAdSpend: calculation.maxAllowableAdSpend,
    targetAcos: calculation.targetAcos,
    breakEvenAcos: calculation.breakEvenAcos
  };
}

function hasMissingCostData(row: ProductEconomicsRow | SafeProductEconomicsRow): boolean {
  const sellingPrice = "selling_price" in row ? row.selling_price : row.sellingPrice;
  const landedCost = "landed_cost" in row ? row.landed_cost : row.landedCost;

  return toNumber(sellingPrice) <= 0 || toNumber(landedCost) <= 0;
}

function hasIncompleteFeeData(row: ProductEconomicsRow): boolean {
  return noteValue(row.notes, "Referral Fee Source") === "MISSING_SUBCATEGORY" || noteValue(row.notes, "Referral Fee Source") === "NO_MATCH";
}

export function toSafeProductEconomicsRow(row: ProductEconomicsRow): SafeProductEconomicsRow {
  const incompleteFeeData = hasIncompleteFeeData(row);
  const referralFeeSource = (noteValue(row.notes, "Referral Fee Source") ?? "REFERRAL_FEE_TABLE") as SafeProductEconomicsRow["referralFeeSource"];
  const netProfit = noteValue(row.notes, "Net Profit") !== null ? noteNumber(row.notes, "Net Profit") : null;
  const profitBands = parseNoteJson(row.notes, "Profit Bands", [] as SafeProductEconomicsRow["profitBands"]);
  const recommendedProfitBand = parseNoteJson(row.notes, "Recommended Profit Band", null as SafeProductEconomicsRow["recommendedProfitBand"]);
  const approval = parseNoteJson(row.notes, "Profit Band Approval", null as SafeProductEconomicsRow["approval"]);
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
    closingFee: noteNumber(row.notes, "Closing Fee"),
    shippingFee: toNumber(row.shipping_fee_estimate),
    pickAndPackFee: noteNumber(row.notes, "Pick & Pack Fee"),
    storageFee: noteNumber(row.notes, "Storage Fee"),
    manualOtherFees: noteNumber(row.notes, "Manual Other Fees"),
    otherFees: noteNumber(row.notes, "Other Fees"),
    totalAmazonFees: noteNumber(row.notes, "Total Amazon Fees"),
    gstOnAmazonFees: toNumber(row.tax_estimate),
    grossProfit: noteValue(row.notes, "Gross Profit") !== null ? noteNumber(row.notes, "Gross Profit") : null,
    netProfit,
    profitMarginPercent: noteValue(row.notes, "Profit Margin Percent") !== null ? noteNumber(row.notes, "Profit Margin Percent") : null,
    productGstRatePercent: noteNumber(row.notes, "Product GST Rate Percent") || 18,
    amazonFeeGstRatePercent: noteNumber(row.notes, "Amazon Fee GST Rate Percent") || 18,
    netRevenueBeforeGst: noteValue(row.notes, "Net Revenue Before GST") !== null ? noteNumber(row.notes, "Net Revenue Before GST") : null,
    outputGstOnSale: noteValue(row.notes, "Output GST On Sale") !== null ? noteNumber(row.notes, "Output GST On Sale") : null,
    returnCostProvision: noteNumber(row.notes, "Return Cost Provision"),
    hiddenOtherFee: noteNumber(row.notes, "Hidden Other Fee"),
    netProfitBeforeAds: noteValue(row.notes, "Net Profit Before Ads") !== null ? noteNumber(row.notes, "Net Profit Before Ads") : null,
    minimumApprovedProfit: noteNumber(row.notes, "Minimum Approved Profit") || toNumber(row.target_profit),
    profitFlexEnabled: noteBoolean(row.notes, "Profit Flex Enabled"),
    profitBands,
    recommendedProfitBand,
    recommendedProfitBandReason: noteValue(row.notes, "Recommended Profit Band Reason") ?? "",
    approval,
    referralFeePercent: noteValue(row.notes, "Referral Fee Percent") !== null ? noteNumber(row.notes, "Referral Fee Percent") : null,
    referralFeeSource,
    feeRulesVersion: noteValue(row.notes, "Fee Rules Version") ?? FEE_RULES_VERSION,
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
    maxAllowableAdSpend: hasMissingCostData(row) || incompleteFeeData ? null : toNumber(row.max_allowable_ad_spend),
    breakEvenAcos: hasMissingCostData(row) || incompleteFeeData ? null : toNumber(row.break_even_acos),
    targetAcos: hasMissingCostData(row) || incompleteFeeData ? null : toNumber(row.target_acos),
    profitStatus: incompleteFeeData ? "NEEDS_INPUT" : hasMissingCostData(row) ? "NEEDS_COST_DATA" : row.profit_status,
    profitDataStatus: incompleteFeeData ? "INCOMPLETE" : hasMissingCostData(row) ? "MISSING_COST_DATA" : "AVAILABLE",
    reason: incompleteFeeData
      ? referralFeeSource === "MISSING_SUBCATEGORY"
        ? "Subcategory is missing, so referral fee cannot be calculated."
        : "Subcategory does not match the referral fee table, so referral fee cannot be calculated."
      : hasMissingCostData(row)
        ? getProfitReason("NEEDS_COST_DATA")
        : getProfitReason(row.profit_status),
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

function normalizeActionSourcePart(value: unknown): string {
  const cleaned = cleanText(value == null ? "" : String(value));
  return cleaned?.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.:-]+/g, "-") ?? "unknown";
}

function mapActionLedgerRisk(value: unknown): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const label = String(value ?? "MEDIUM").toUpperCase();
  if (label === "VERY_HIGH" || label === "CRITICAL") return "CRITICAL";
  if (label === "HIGH") return "HIGH";
  if (label === "LOW") return "LOW";
  return "MEDIUM";
}

async function ensureProductEconomicsAlerts(row: SafeProductEconomicsRow): Promise<void> {
  const productKey = row.sku ?? row.asin;
  const baseInput = {
    sellerId: row.sellerId,
    source: "PRODUCT_ECONOMICS" as const,
    entityType: "SKU" as const,
    entityId: row.sku ?? row.asin,
    sku: row.sku,
    asin: row.asin,
    confidenceLabel: "MEDIUM" as const,
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL" as const,
    approvalStatus: "PENDING" as const,
    guardrails: {
      shadowMode: true,
      externalExecution: false,
      requiresFounderApproval: true
    }
  };
  const band = row.recommendedProfitBand ?? row.approval?.requestedProfitBand ?? null;

  if (band) {
    await ensureActionLedgerAction({
      ...baseInput,
      sourceId: `product-economics:${normalizeActionSourcePart(productKey)}:profit-band:${normalizeActionSourcePart(band.bandLabel)}`,
      actionType: "PROFIT_BAND_APPROVAL",
      title: `Approve profit band for ${row.sku ?? row.productName ?? row.asin ?? "product"}`,
      summary: row.approval?.reason ?? row.recommendedProfitBandReason,
      recommendedAction: "APPROVE_PROFIT_BAND",
      expectedProfitImpact: band.minProfit,
      riskLevel: mapActionLedgerRisk(band.riskLevel),
      approvalTier: band.approvalTier === "FOUNDER_OVERRIDE_REQUIRED" ? "FOUNDER_OVERRIDE" : band.approvalTier === "HIGH_RISK_APPROVAL" ? "TIER_3" : "TIER_2",
      payload: {
        profitBand: band,
        currentRequiredProfit: row.approval?.currentRequiredProfit ?? row.requiredProfit,
        shadowMode: true,
        externalExecution: false
      },
      evidence: {
        productEconomicsId: row.id,
        profitStatus: row.profitStatus,
        profitDataStatus: row.profitDataStatus,
        targetAcos: row.targetAcos,
        breakEvenAcos: row.breakEvenAcos
      }
    });
  }

  if (row.profitDataStatus === "MISSING_COST_DATA" || row.profitDataStatus === "INCOMPLETE" || row.requiredProfit <= 0) {
    await ensureActionLedgerAction({
      ...baseInput,
      sourceId: `product-economics:${normalizeActionSourcePart(productKey)}:missing-cost-data`,
      actionType: "COST_DATA_REQUIRED",
      title: `Complete product cost data for ${row.sku ?? row.productName ?? row.asin ?? "product"}`,
      summary: row.reason,
      recommendedAction: "COMPLETE_COST_DATA",
      expectedProfitImpact: null,
      riskLevel: "MEDIUM",
      approvalTier: "TIER_2",
      payload: {
        profitDataStatus: row.profitDataStatus,
        profitStatus: row.profitStatus,
        requiredProfit: row.requiredProfit,
        shadowMode: true,
        externalExecution: false
      },
      evidence: {
        productEconomicsId: row.id,
        landedCost: row.landedCost,
        sellingPrice: row.sellingPrice,
        targetAcos: row.targetAcos,
        breakEvenAcos: row.breakEvenAcos
      }
    });
  }

  const hasUnsafeProfitStatus = ["BLOCKED", "FAIL", "RISK"].includes(row.profitStatus);
  const hasTargetAcosRisk = row.targetAcos !== null && (row.targetAcos <= 5 || row.targetAcos >= 80);

  if (hasUnsafeProfitStatus || hasTargetAcosRisk) {
    const riskReason = hasUnsafeProfitStatus ? row.profitStatus : "target-acos-risk";

    await ensureActionLedgerAction({
      ...baseInput,
      sourceId: `product-economics:${normalizeActionSourcePart(productKey)}:profit-risk:${normalizeActionSourcePart(riskReason)}`,
      actionType: "PROFIT_RISK_REVIEW",
      title: `Review profit risk for ${row.sku ?? row.productName ?? row.asin ?? "product"}`,
      summary: row.reason,
      recommendedAction: "REVIEW_PROFIT_RISK",
      expectedProfitImpact: row.netProfit,
      riskLevel: row.profitStatus === "BLOCKED" || row.profitStatus === "FAIL" ? "HIGH" : "MEDIUM",
      approvalTier: row.profitStatus === "BLOCKED" || row.profitStatus === "FAIL" ? "TIER_3" : "TIER_2",
      payload: {
        profitStatus: row.profitStatus,
        profitDataStatus: row.profitDataStatus,
        targetAcos: row.targetAcos,
        breakEvenAcos: row.breakEvenAcos,
        maxAllowableAdSpend: row.maxAllowableAdSpend,
        requiredProfit: row.requiredProfit,
        shadowMode: true,
        externalExecution: false
      },
      evidence: {
        productEconomicsId: row.id,
        sellingPrice: row.sellingPrice,
        nonAdCost: row.nonAdCost,
        netProfit: row.netProfit,
        netProfitBeforeAds: row.netProfitBeforeAds
      }
    });
  }
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
    amazon_fee_estimate: calculation.referralFee,
    shipping_fee_estimate: calculation.shippingFee,
    tax_estimate: calculation.gstOnAmazonFees,
    return_rate_percent: roundTwo(input.returnRatePercent),
    return_cost_per_return: roundTwo(input.returnCostPerReturn),
    return_reserve_per_unit: calculation.returnReservePerUnit,
    influencer_cost_allocation_per_unit: roundTwo(input.influencerCostAllocationPerUnit),
    social_marketing_cost_per_unit: roundTwo(input.socialMarketingCostPerUnit),
    coupon_discount_estimate: roundTwo(input.couponDiscountEstimate),
    other_cost_per_unit: calculation.otherFees,
    target_profit: calculation.targetProfit,
    target_profit_rule: calculation.targetProfitRule,
    non_ad_cost: calculation.nonAdCost,
    max_allowable_ad_spend: calculation.maxAllowableAdSpend,
    break_even_acos: calculation.breakEvenAcos,
    target_acos: calculation.targetAcos,
    profit_status: calculation.profitStatus,
    notes: buildCalculationNotes(input, calculation),
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

  const safeRow = toSafeProductEconomicsRow(data);
  await ensureProductEconomicsAlerts(safeRow).catch((ledgerError) => {
    logger.warn("Could not sync product economics alerts to action ledger.", {
      sellerId: safeRow.sellerId,
      sku: safeRow.sku,
      message: sanitizeErrorMessage(ledgerError instanceof Error ? ledgerError.message : "Unknown action ledger error")
    });
  });

  return safeRow;
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
    listing?: AmazonSpListingRow | null;
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
    const media = normalizeProductMedia([input.listing ?? null, passport], {
      lastImageSyncAt: latestTimestamp([input.listing?.last_synced_at, input.listing?.updated_at, passport?.updated_at]),
      amazonImagePreferred: Boolean(input.listing)
    });
    const missingFields: string[] = [];
    const hasSubcategoryMatch = Boolean(subcategory && referralFeeRules[normalizeCategory(subcategory) ?? ""]);

    if (!subcategory || !hasSubcategoryMatch) missingFields.push("subcategory");
    if (!existingEconomics || productCost <= 0) missingFields.push("productCost");
    if (!existingEconomics || requiredProfit <= 0) missingFields.push("requiredProfit");
    if (!fulfillmentType) missingFields.push("fulfillmentType");
    if (!productType) missingFields.push("productType");
    if (weightKg <= 0) missingFields.push("weightKg");

    let costStatus: CostCompletionStatus = "INCOMPLETE";
    let nextActionLabel = "Complete missing inputs";

    if (!subcategory || !hasSubcategoryMatch || existingEconomics?.profitStatus === "NEEDS_INPUT") {
      costStatus = "INCOMPLETE";
      nextActionLabel = "Select subcategory";
    } else if (!existingEconomics || productCost <= 0) {
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
      mainImageUrl: media.mainImageUrl,
      imageUrl: media.imageUrl,
      amazonImageUrl: media.amazonImageUrl,
      imageSource: media.imageSource,
      lastImageSyncAt: media.lastImageSyncAt,
      images: media.images,
      imageStatus: media.imageStatus,
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
      listing,
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
