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

const FEE_RULES_VERSION = "amazon_fee_engine_v2_real_data_2026_09_28";

// referralFeeRules — 2026-09-28 update.
//
// Amazon introduced a zero-referral-fee-under-Rs.1,000 policy in March 2026 across a large
// share of its India catalog. Two categories below have been directly, word-for-word confirmed
// against Amazon's own live Referral Fees table (sell.amazon.in/fees-and-pricing, re-checked
// 2026-09-25) AND cross-checked against real August 2026 settlement data for this account:
//   - "home decor products": 0% <= Rs.1,000, 17% above (was wrongly coded here as a flat 12%
//     above 1000 - the confirmed real rate is 17%, not 12%).
//   - "home improvement - accessories": 0% <= Rs.1,000, 13.5% above (was wrongly coded as a
//     flat 12% at ANY price - this category never had its zero-fee tier at all before this fix).
// Every OTHER category below is still the ORIGINAL, UNVERIFIED flat rate this file has always
// used. Given how broad Amazon's March 2026 policy change was, it is very likely several of
// these are also wrong (missing a zero-fee-under-Rs.1,000 tier), but each one needs its own
// check against Amazon's live fee table before being changed - do not assume the same fix
// applies without checking, and do not guess a number that hasn't been confirmed (see
// referralFeeConfidence on the calculation output, which flags exactly this).
const CONFIRMED_REFERRAL_CATEGORIES = new Set(["home decor products", "home improvement - accessories"]);

const referralFeeRules: Record<string, Array<{ maxPrice: number; percent: number }>> = {
  "home decor products": [{ maxPrice: 1000, percent: 0 }, { maxPrice: Number.POSITIVE_INFINITY, percent: 17 }],
  "home - other products": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home improvement - other products": [{ maxPrice: Number.POSITIVE_INFINITY, percent: 12 }],
  "home improvement - accessories": [{ maxPrice: 1000, percent: 0 }, { maxPrice: Number.POSITIVE_INFINITY, percent: 13.5 }],
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

// Some products carry an informal/free-text subcategory in the Product Passport instead of one
// of the exact Amazon subcategory names above. Rather than silently blocking the profit
// calculation for these, map known informal terms to the closest real Amazon subcategory
// already in the table above.
//
// Added 2026-09-24: found this affecting Ziro kart products specifically, which use short
// internal ALL_CAPS_WITH_UNDERSCORES codes (e.g. "PLANTER", "FUEL_LAMP") rather than Amazon's
// real subcategory names the way Leafy Dew's product data does. resolveCategoryKey() below also
// converts underscores to spaces before checking this list, so any other Ziro kart code in the
// same style will match here once its underscore-to-space form is added.
//
// - "planter"/"planters"/"plant pot(s)"/"flower pot(s)" -> "home improvement - accessories",
//   matching how the other planter-type product already in this catalog (FENGZHITAO
//   Self-Watering Planter, SKU ER-NBXG-TZGE) was classified.
// - "fuel lamp" -> "home decor products", for Ziro kart's gold-plated diya/deepam stand
//   (SKU Ziro kart_ LD25UD002G_New) — a decorative pooja/festival item, not an electric
//   lighting fixture, so "home decor products" fits better than "indoor lighting".
//
// Extend this list if the same NO_MATCH issue shows up again for a different informal value —
// worth also flagging to the founder that fixing this at the source (using Amazon's real
// subcategory names when Ziro kart product data is entered) would prevent it recurring.
const subcategoryAliases: Record<string, string> = {
  "planter": "home improvement - accessories",
  "planters": "home improvement - accessories",
  "plant pot": "home improvement - accessories",
  "plant pots": "home improvement - accessories",
  "flower pot": "home improvement - accessories",
  "flower pots": "home improvement - accessories",
  "fuel lamp": "home decor products"
};

function resolveCategoryKey(subcategory: string): string {
  if (referralFeeRules[subcategory]) return subcategory;
  if (subcategoryAliases[subcategory]) return subcategoryAliases[subcategory];
  const spaced = subcategory.replace(/_/g, " ").trim();
  if (spaced !== subcategory) {
    if (referralFeeRules[spaced]) return spaced;
    if (subcategoryAliases[spaced]) return subcategoryAliases[spaced];
  }
  return subcategory;
}

function getReferralFee(input: ProductEconomicsInput, sellingPrice: number): {
  source: "REFERRAL_FEE_TABLE" | "MISSING_SUBCATEGORY" | "NO_MATCH";
  percent: number | null;
  amount: number;
  confidence: "CONFIRMED" | "UNVERIFIED_LEGACY";
} {
  const rawSubcategory = normalizeCategory(input.subcategoryOverride ?? input.subCategory);
  if (!rawSubcategory) return { source: "MISSING_SUBCATEGORY", percent: null, amount: 0, confidence: "UNVERIFIED_LEGACY" };
  const subcategory = resolveCategoryKey(rawSubcategory);
  const confidence: "CONFIRMED" | "UNVERIFIED_LEGACY" = CONFIRMED_REFERRAL_CATEGORIES.has(subcategory)
    ? "CONFIRMED"
    : "UNVERIFIED_LEGACY";

  const rules = referralFeeRules[subcategory];
  if (!rules) return { source: "NO_MATCH", percent: null, amount: 0, confidence };

  const rule = rules.find((item) => sellingPrice <= item.maxPrice);
  if (!rule) return { source: "NO_MATCH", percent: null, amount: 0, confidence };

  return {
    source: "REFERRAL_FEE_TABLE",
    percent: rule.percent,
    amount: roundTwo((sellingPrice * rule.percent) / 100),
    confidence
  };
}

// getClosingFee — rewritten 2026-09-28.
//
// The previous version used ONE flat schedule (<=250:5, <=500:22, <=1000:25, else:50) regardless
// of fulfillment channel, and had never been updated for Amazon's Sept 7, 2026 closing-fee
// increase (confirmed live on Amazon's fees page: +Rs.1 for items <=Rs.500, +Rs.3 above). Real
// August 2026 settlement data for this account's Easy Ship orders confirms the Easy Ship figures
// below EXACTLY (Rs.2 for <=300, Rs.23 for 301-500). The FC, Self Ship and Seller Flex figures
// come from Amazon's own published post-increase rate but have NOT been checked against a real
// settled order on those channels for this account (this account's real order data seen so far
// is 100% Easy Ship) - safe to use, worth a real-order check if/when this account starts
// fulfilling through one of those other channels.
//
// categoryException keeps its EXISTING meaning from before this change (a flag that fully waives
// the closing fee to Rs.0) - that behavior is unchanged here, since it was not part of what was
// checked/confirmed this round.
const CLOSING_FEE_BANDS: Record<string, Array<{ maxPrice: number; fee: number }>> = {
  fc: [
    { maxPrice: 300, fee: 27 },
    { maxPrice: 500, fee: 23 },
    { maxPrice: 1000, fee: 25 },
    { maxPrice: Number.POSITIVE_INFINITY, fee: 75 }
  ],
  easy_ship: [
    { maxPrice: 300, fee: 2 },
    { maxPrice: 500, fee: 23 },
    { maxPrice: 1000, fee: 36 },
    { maxPrice: Number.POSITIVE_INFINITY, fee: 67 }
  ],
  easy_ship_prime: [
    { maxPrice: 300, fee: 2 },
    { maxPrice: 500, fee: 23 },
    { maxPrice: 1000, fee: 36 },
    { maxPrice: Number.POSITIVE_INFINITY, fee: 67 }
  ],
  self_ship: [
    { maxPrice: 300, fee: 20 },
    { maxPrice: 500, fee: 26 },
    { maxPrice: 1000, fee: 50 },
    { maxPrice: Number.POSITIVE_INFINITY, fee: 100 }
  ],
  seller_flex: [
    { maxPrice: 300, fee: 7 },
    { maxPrice: 500, fee: 13 },
    { maxPrice: 1000, fee: 36 },
    { maxPrice: Number.POSITIVE_INFINITY, fee: 67 }
  ]
};

function getClosingFee(
  sellingPrice: number,
  categoryException: boolean | null | undefined,
  fulfillmentType: string | null | undefined
): { fee: number; channelUsed: string } {
  if (categoryException) return { fee: 0, channelUsed: "category_exception_waived" };

  const normalizedChannel = normalizeFulfillmentType(fulfillmentType);
  // Default to Easy Ship when the channel is missing/unrecognized - this account's real orders
  // are overwhelmingly Easy Ship, so this is the safer fallback than the old channel-blind table.
  const channelKey = normalizedChannel && CLOSING_FEE_BANDS[normalizedChannel] ? normalizedChannel : "easy_ship";
  const bands = CLOSING_FEE_BANDS[channelKey];
  const band = bands.find((item) => sellingPrice <= item.maxPrice) ?? bands[bands.length - 1];

  return { fee: band.fee, channelUsed: channelKey };
}

// getRefundCommission — Amazon India's real "Refund Commission" charge, confirmed 2026-09-25
// against real August 2026 settlement data (7 of 9 real refunded orders matched one of these two
// figures with no exceptions) and against Amazon India seller-forum reports describing the same
// fee. Charged INSTEAD of reversing the original referral+closing fee on some refunds.
function getRefundCommission(sellingPrice: number): number {
  if (sellingPrice <= 0) return 0;
  return sellingPrice <= 300 ? 59 : 88.5; // Rs.50+18% GST, or Rs.75+18% GST
}

// getReturnCostPerUnit — replaces the old flat "10% of selling price" return reserve.
//
// Built 2026-09-28 from real, direct evidence: querying every refunded order in the real August
// 2026 settlement CSV found 6 of 9 refunds (66.7%) never had their original referral+closing fee
// OR their shipping fee reversed, and instead were charged a brand-new Refund Commission - a
// genuine "triple hit," not just a lost sale. The other 3 of 9 (33.3%) got everything reversed
// cleanly with no extra fee cost. This blends both outcomes using the real split, then smears the
// expected extra cost across the successful (non-returned) orders - the same math the founder
// described from his own observed 1-in-4 return pattern ("divide return charges in 3 orders"),
// generalized to any return rate: cost * (rate/100) / (1 - rate/100).
//
// returnRecoverable (founder-confirmed 2026-09-28): most returned units ARE resold after a
// repackaging job (his stated cost: ~Rs.10), and damaged units are claimed back from Amazon
// rather than absorbed as a full loss - so the default product-cost impact of a return is the
// repackaging cost, not the full purchase price. Set returnRecoverable=false for a specific
// product/case that is genuinely a total write-off.
function getReturnCostPerUnit(input: {
  returnRatePercent: number;
  returnPenaltyFractionPercent: number;
  returnRecoverable: boolean;
  repackagingCost: number;
  referralFee: number;
  closingFee: number;
  shippingFee: number;
  productCost: number;
  sellingPrice: number;
}): number {
  if (input.returnRatePercent <= 0) return 0;

  const refundCommission = getRefundCommission(input.sellingPrice);
  const penaltyCost = input.referralFee + input.closingFee + input.shippingFee + refundCommission;
  const penaltyFraction = Math.min(Math.max(input.returnPenaltyFractionPercent, 0), 100) / 100;
  const expectedFeeCost = penaltyFraction * penaltyCost;
  const productLossPerReturn = input.returnRecoverable ? input.repackagingCost : input.productCost;
  const totalCostPerReturn = expectedFeeCost + productLossPerReturn;

  const rate = Math.min(Math.max(input.returnRatePercent, 0), 99.9) / 100;
  return roundTwo((totalCostPerReturn * rate) / (1 - rate));
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
  // Default changed 10 -> 25 on 2026-09-28: the founder's own stated, observed return pattern
  // is "1 in 4 orders returned" (25%). Still fully overridable per product.
  const returnRatePercent = toNumber(input.returnRatePercent ?? 25);
  const returnPenaltyFractionPercent = toNumber(input.returnPenaltyFractionPercent ?? 66.7);
  const returnRecoverable = input.returnRecoverable ?? true;
  const repackagingCost = toNumber(input.repackagingCost ?? 10);
  const tcsPercent = toNumber(input.tcsPercent ?? 0.5);
  const minimumApprovedProfit = toNumber(input.minimumApprovedProfit ?? targetProfit);
  const profitFlexEnabled = Boolean(input.profitFlexEnabled);
  const referralFee = getReferralFee(input, sellingPrice);
  const closingFeeResult = getClosingFee(sellingPrice, input.categoryException, input.fulfillmentType);
  const closingFee = closingFeeResult.fee;
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
  // Real, evidence-based return cost (see getReturnCostPerUnit) - replaces the old flat
  // "10% of selling price" placeholder with the confirmed triple-hit / resale-aware model.
  const returnReservePerUnit = getReturnCostPerUnit({
    returnRatePercent,
    returnPenaltyFractionPercent,
    returnRecoverable,
    repackagingCost,
    referralFee: referralFee.amount,
    closingFee,
    shippingFee,
    productCost,
    sellingPrice
  });
  const netProfitBeforeAds =
    netRevenueBeforeGst === null
      ? null
      : roundTwo(netRevenueBeforeGst - productCost - totalAmazonFees - gstOnAmazonFees - returnReservePerUnit);
  const nonAdCost = roundTwo(productCost + totalAmazonFees + gstOnAmazonFees + returnReservePerUnit);
  // "Real Cash From Amazon Today" vs. true profit - the same distinction proven out in the
  // founder's Excel profit calculator this week: Amazon Settlement is what actually lands in the
  // bank (after TCS withholding), which is different from true economic profit (which credits
  // TCS back, since it's a reclaimable tax credit, not a real expense).
  const amazonSettlementEstimate = sellingPrice > 0 ? roundTwo(sellingPrice - totalAmazonFees - gstOnAmazonFees) : null;
  const tcsAmount = netRevenueBeforeGst === null ? 0 : roundTwo(netRevenueBeforeGst * (tcsPercent / 100));
  const realCashToday = amazonSettlementEstimate === null ? null : roundTwo(amazonSettlementEstimate - tcsAmount);
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
    reason,
    referralFeeConfidence: referralFee.confidence,
    closingFeeChannelUsed: closingFeeResult.channelUsed,
    refundCommissionPerReturn: getRefundCommission(sellingPrice),
    tcsAmount,
    amazonSettlementEstimate,
    realCashToday,
    // Real ad spend needs a live Supabase lookup (amazon_ads_advertised_product_daily_metrics),
    // which this function can't do since it's a pure/sync calculator. saveProductEconomics()
    // fills these in for real, persisted rows right after calling this function - see
    // getRealAdSpendPerUnit() below. getProductEconomicsFormulaCheckExample() and any other
    // caller of this function directly will correctly see these as "not available" rather than
    // a guessed number.
    realAdSpendPerUnit: null,
    realAdSpendWindowDays: null,
    realAdSpendDataAvailable: false,
    realNetProfitAfterAds: null,
    realProfitMarginPercent: null
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
    updatedAt: row.updated_at,
    // Added 2026-09-28 - read from the new columns (amazon_product_economics_real_profit.sql).
    // Falls back to sensible defaults if that migration hasn't been run yet in a given
    // environment, so this never throws on an older row shape.
    returnPenaltyFractionPercent: row.return_penalty_fraction_percent !== undefined && row.return_penalty_fraction_percent !== null
      ? toNumber(row.return_penalty_fraction_percent)
      : 66.7,
    returnRecoverable: row.return_recoverable ?? true,
    repackagingCost: row.repackaging_cost !== undefined && row.repackaging_cost !== null ? toNumber(row.repackaging_cost) : 10,
    tcsPercent: row.tcs_percent !== undefined && row.tcs_percent !== null ? toNumber(row.tcs_percent) : 0.5,
    tcsAmount: toNumber(row.tcs_amount),
    amazonSettlementEstimate: row.amazon_settlement_estimate !== undefined && row.amazon_settlement_estimate !== null
      ? toNumber(row.amazon_settlement_estimate)
      : null,
    realCashToday: row.real_cash_today !== undefined && row.real_cash_today !== null ? toNumber(row.real_cash_today) : null,
    referralFeeConfidence: (row.referral_fee_confidence as SafeProductEconomicsRow["referralFeeConfidence"]) ?? "UNVERIFIED_LEGACY",
    closingFeeChannelUsed: row.closing_fee_channel_used ?? "easy_ship",
    refundCommissionPerReturn: toNumber(row.refund_commission_per_return),
    realAdSpendPerUnit: row.real_ad_spend_per_unit !== undefined && row.real_ad_spend_per_unit !== null
      ? toNumber(row.real_ad_spend_per_unit)
      : null,
    realAdSpendWindowDays: row.real_ad_spend_window_days !== undefined && row.real_ad_spend_window_days !== null
      ? toNumber(row.real_ad_spend_window_days)
      : null,
    realAdSpendDataAvailable: Boolean(row.real_ad_spend_data_available),
    realNetProfitAfterAds: row.real_net_profit_after_ads !== undefined && row.real_net_profit_after_ads !== null
      ? toNumber(row.real_net_profit_after_ads)
      : null,
    realProfitMarginPercent:
      row.real_net_profit_after_ads !== undefined && row.real_net_profit_after_ads !== null && toNumber(row.selling_price) > 0
        ? roundTwo((toNumber(row.real_net_profit_after_ads) / toNumber(row.selling_price)) * 100)
        : null
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

// getRealAdSpendPerUnit — added 2026-09-28, Workstream 1 of the founder's "make ad cost real"
// request. The app already syncs real, per-ASIN/per-SKU daily ad spend and attributed orders
// into amazon_ads_advertised_product_daily_metrics (built for the Sponsored Products report,
// see amazon-ads-report.service.ts) - this reuses that same real data rather than adding a new
// sync path. Sums cost and attributed orders over a trailing window and returns spend per unit
// actually sold (cost / orders), which is the real, backward-looking cost of ads for this
// product - distinct from the existing maxAllowableAdSpend/targetAcos, which are forward-looking
// BUDGET ceilings, not what was actually spent. Both are useful; they answer different questions.
//
// Deliberately returns null (not 0) when there's no attributed order in the window, rather than
// silently treating "no orders" as "no ad cost" - ads can spend real money with zero attributed
// sales (this account's own Today page has shown ACOS above 100%), and reporting Rs.0 in that
// case would hide exactly the problem the founder flagged ("ad cost is very high, almost the
// product price").
export async function getRealAdSpendPerUnit(input: {
  sellerId: string;
  asin?: string | null;
  sku?: string | null;
  windowDays?: number;
}): Promise<{
  adSpendPerUnit: number | null;
  windowDays: number;
  totalCost: number;
  totalOrders: number;
  dataAvailable: boolean;
}> {
  const windowDays = input.windowDays ?? 30;
  const asin = cleanText(input.asin);
  const sku = cleanText(input.sku);

  if (!asin && !sku) {
    return { adSpendPerUnit: null, windowDays, totalCost: 0, totalOrders: 0, dataAvailable: false };
  }

  const sinceDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let query = supabase
    .from("amazon_ads_advertised_product_daily_metrics")
    .select("cost, orders")
    .eq("seller_id", cleanText(input.sellerId) ?? "default")
    .gte("report_date", sinceDate);

  query = asin ? query.eq("advertised_asin", asin) : query.eq("advertised_sku", sku as string);

  const { data, error } = await query;

  if (error) {
    logger.warn("Could not load real ad spend for product economics.", {
      message: sanitizeErrorMessage(error.message)
    });
    return { adSpendPerUnit: null, windowDays, totalCost: 0, totalOrders: 0, dataAvailable: false };
  }

  const rows = (data ?? []) as Array<{ cost: number | string | null; orders: number | string | null }>;
  const totalCost = roundTwo(rows.reduce((sum, row) => sum + toNumber(row.cost), 0));
  const totalOrders = rows.reduce((sum, row) => sum + toNumber(row.orders), 0);

  if (rows.length === 0) {
    return { adSpendPerUnit: null, windowDays, totalCost: 0, totalOrders: 0, dataAvailable: false };
  }

  if (totalOrders <= 0) {
    return { adSpendPerUnit: null, windowDays, totalCost, totalOrders, dataAvailable: true };
  }

  return { adSpendPerUnit: roundTwo(totalCost / totalOrders), windowDays, totalCost, totalOrders, dataAvailable: true };
}

export async function saveProductEconomics(input: ProductEconomicsInput): Promise<SafeProductEconomicsRow> {
  const calculation = calculateProductEconomics(input);

  // Enrich with real ad spend right after the pure calculation - see getRealAdSpendPerUnit above.
  // Wrapped in try/catch so a temporary Supabase hiccup on the ads tables never blocks saving the
  // rest of a product's (already-correct) fee/profit numbers.
  try {
    const adSpend = await getRealAdSpendPerUnit({
      sellerId: cleanText(input.sellerId) ?? "default",
      asin: input.asin,
      sku: input.sku
    });
    calculation.realAdSpendPerUnit = adSpend.adSpendPerUnit;
    calculation.realAdSpendWindowDays = adSpend.windowDays;
    calculation.realAdSpendDataAvailable = adSpend.dataAvailable;
    calculation.realNetProfitAfterAds =
      calculation.netProfitBeforeAds !== null && adSpend.adSpendPerUnit !== null
        ? roundTwo(calculation.netProfitBeforeAds - adSpend.adSpendPerUnit)
        : null;
    calculation.realProfitMarginPercent =
      calculation.realNetProfitAfterAds !== null && toNumber(input.sellingPrice) > 0
        ? roundTwo((calculation.realNetProfitAfterAds / toNumber(input.sellingPrice)) * 100)
        : null;
  } catch (adSpendError) {
    logger.warn("Could not enrich product economics with real ad spend.", {
      message: sanitizeErrorMessage(adSpendError instanceof Error ? adSpendError.message : "Unknown ad spend error")
    });
  }

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
    updated_at: now,
    // Added 2026-09-28 - see amazon_product_economics_real_profit.sql.
    return_penalty_fraction_percent: roundTwo(toNumber(input.returnPenaltyFractionPercent ?? 66.7)),
    return_recoverable: input.returnRecoverable ?? true,
    repackaging_cost: roundTwo(toNumber(input.repackagingCost ?? 10)),
    tcs_percent: roundTwo(toNumber(input.tcsPercent ?? 0.5)),
    tcs_amount: calculation.tcsAmount,
    amazon_settlement_estimate: calculation.amazonSettlementEstimate,
    real_cash_today: calculation.realCashToday,
    referral_fee_confidence: calculation.referralFeeConfidence,
    closing_fee_channel_used: calculation.closingFeeChannelUsed,
    refund_commission_per_return: calculation.refundCommissionPerReturn,
    real_ad_spend_per_unit: calculation.realAdSpendPerUnit,
    real_ad_spend_window_days: calculation.realAdSpendWindowDays,
    real_ad_spend_data_available: calculation.realAdSpendDataAvailable,
    real_net_profit_after_ads: calculation.realNetProfitAfterAds
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
    const normalizedSubcategory = normalizeCategory(subcategory);
    const hasSubcategoryMatch = Boolean(normalizedSubcategory && referralFeeRules[resolveCategoryKey(normalizedSubcategory)]);

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

    // Prefer the matched Product Passport's own sku/asin (its canonical identity) over the raw
    // Amazon listing's, when a passport was found. Amazon sellers sometimes relabel a product's
    // SKU over time; when that happens, the OLD sku can keep sitting in amazon_sp_listings
    // (Amazon's listings report still returns it, so our sync keeps refreshing that stale row)
    // even though the real, current Product Passport for that same ASIN now uses a new sku.
    // Without this, this queue row gets keyed by the stale sku, so the frontend (which dedupes
    // products by sku/asin) sees it as a second, phantom product distinct from the real
    // passport-backed one — silently inflating "Total Products" / "Active Listings" counts by
    // one for every product whose SKU was ever changed on Amazon. Aligning the identity here
    // makes this row collapse into the same key as the real passport everywhere it's merged.
    return {
      sku: cleanText(passport?.sku ?? input.sku),
      asin: cleanText(passport?.asin ?? input.asin),
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
