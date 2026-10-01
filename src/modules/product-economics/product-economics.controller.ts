import { Request, Response } from "express";
import { z } from "zod";
import {
  buildProductEconomicsExplanation,
  getCostCompletionQueue,
  getCostReductionOpportunities,
  getProductEconomicsById,
  listProductEconomics,
  saveProductEconomics
} from "./product-economics.service";
import { getMeasuredReturnRates, RETURN_LOOKBACK_DAYS, RETURN_MIN_UNITS, RETURN_RISK_RATE_PCT } from "../returns/measured-return-rate.service";
import { applyReturnRateSwitch, getReturnRatePreview, undoReturnRateSwitch } from "./return-rate-preview.service";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const shippingRegionSchema = z
  .preprocess((value) => value ?? "National", z.string())
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : "National";
  });

const categoryExceptionSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["yes", "y", "true"].includes(normalized)) return true;
    if (["no", "n", "false", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean().default(false));

const booleanSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(normalized)) return true;
    if (["no", "n", "false", "0", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean().default(false));

// Same normalization as booleanSchema, but defaults to true when omitted - used for
// returnRecoverable below, where "recoverable" (resold after repackaging, or claimed from
// Amazon) is the founder's confirmed NORMAL case, not the exception.
const booleanSchemaDefaultTrue = z.preprocess((value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(normalized)) return true;
    if (["no", "n", "false", "0", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean().default(true));

const productEconomicsBodySchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  marketplaceId: nullableTextSchema,
  asin: nullableTextSchema,
  sku: z.string().trim().min(1, "SKU is required."),
  productName: nullableTextSchema,
  subCategory: nullableTextSchema,
  subcategoryOverride: nullableTextSchema,
  fulfillmentType: nullableTextSchema,
  productType: nullableTextSchema,
  shippingRegion: shippingRegionSchema.default("National"),
  categoryException: categoryExceptionSchema,
  weightKg: z.coerce.number().min(0).optional(),
  volumeCuFt: z.coerce.number().min(0).optional(),
  hiddenOtherFee: z.coerce.number().min(0).default(10),
  productGstRatePercent: z.coerce.number().min(0).default(18),
  amazonFeeGstRatePercent: z.coerce.number().min(0).default(18),
  minimumApprovedProfit: z.coerce.number().min(0).optional(),
  profitFlexEnabled: booleanSchema,
  sellingPrice: z.coerce.number().min(0, "sellingPrice must be 0 or higher."),
  productCost: z.coerce.number().min(0).optional(),
  buyingCost: z.coerce.number().min(0).optional(),
  landedCost: z.coerce.number().min(0).default(0),
  packagingCost: z.coerce.number().min(0).default(0),
  shippingCost: z.coerce.number().min(0).optional(),
  referralFee: z.coerce.number().min(0).optional(),
  closingFee: z.coerce.number().min(0).optional(),
  amazonFeeEstimate: z.coerce.number().min(0).default(0),
  shippingFeeEstimate: z.coerce.number().min(0).default(0),
  taxEstimate: z.coerce.number().min(0).default(0),
  // Default changed 10 -> 25 on 2026-09-28: the founder's own stated, observed return pattern is
  // "1 in 4 orders returned" (25%). Still fully overridable per product from the frontend.
  returnRatePercent: z.coerce.number().min(0).default(25),
  returnCostPerReturn: z.coerce.number().min(0).default(0),
  returnReservePerUnit: z.coerce.number().min(0).optional(),
  // Added 2026-09-28 - see product-economics.service.ts (getReturnCostPerUnit) for the full
  // rationale. Defaults match the founder's confirmed real business process: most returns are
  // resold after a Rs.10 repackaging job, or claimed back from Amazon if damaged.
  returnPenaltyFractionPercent: z.coerce.number().min(0).max(100).default(66.7),
  returnRecoverable: booleanSchemaDefaultTrue,
  repackagingCost: z.coerce.number().min(0).default(10),
  tcsPercent: z.coerce.number().min(0).default(0.5),
  influencerCostAllocationPerUnit: z.coerce.number().min(0).default(0),
  socialMarketingCostPerUnit: z.coerce.number().min(0).default(0),
  couponDiscountEstimate: z.coerce.number().min(0).default(0),
  otherFees: z.coerce.number().min(0).optional(),
  otherCostPerUnit: z.coerce.number().min(0).default(0),
  requiredProfit: z.coerce.number().min(0).optional(),
  targetProfit: z.coerce.number().min(0).optional(),
  notes: nullableTextSchema
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function sendProductEconomicsError(res: Response, message: string): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run amazon_product_economics.sql in Supabase and check the service role key."
  });
}

function toFounderEconomics(row: Awaited<ReturnType<typeof saveProductEconomics>>) {
  return {
    sellerId: row.sellerId,
    sku: row.sku,
    asin: row.asin,
    sellingPrice: row.sellingPrice,
    buyingCost: row.buyingCost,
    packagingCost: row.packagingCost,
    shippingCost: row.shippingCost,
    referralFee: row.referralFee,
    closingFee: row.closingFee,
    shippingFee: row.shippingFee,
    pickAndPackFee: row.pickAndPackFee,
    storageFee: row.storageFee,
    manualOtherFees: row.manualOtherFees,
    otherFees: row.otherFees,
    totalAmazonFees: row.totalAmazonFees,
    gstOnAmazonFees: row.gstOnAmazonFees,
    grossProfit: row.grossProfit,
    netProfit: row.netProfit,
    profitMarginPercent: row.profitMarginPercent,
    productGstRatePercent: row.productGstRatePercent,
    amazonFeeGstRatePercent: row.amazonFeeGstRatePercent,
    netRevenueBeforeGst: row.netRevenueBeforeGst,
    outputGstOnSale: row.outputGstOnSale,
    returnRatePercent: row.returnRatePercent,
    returnCostProvision: row.returnCostProvision,
    hiddenOtherFee: row.hiddenOtherFee,
    netProfitBeforeAds: row.netProfitBeforeAds,
    minimumApprovedProfit: row.minimumApprovedProfit,
    profitBands: row.profitBands,
    recommendedProfitBand: row.recommendedProfitBand,
    recommendedProfitBandReason: row.recommendedProfitBandReason,
    profitFlexEnabled: row.profitFlexEnabled,
    approval: row.approval,
    referralFeePercent: row.referralFeePercent,
    referralFeeSource: row.referralFeeSource,
    requiredProfit: row.requiredProfit,
    nonAdCost: row.nonAdCost,
    maxAllowableAdSpend: row.maxAllowableAdSpend,
    targetAcos: row.targetAcos,
    breakEvenAcos: row.breakEvenAcos,
    profitStatus: row.profitStatus,
    profitDataStatus: row.profitDataStatus,
    feeRulesVersion: row.feeRulesVersion,
    reason: row.reason,
    // Added 2026-09-28
    referralFeeConfidence: row.referralFeeConfidence,
    closingFeeChannelUsed: row.closingFeeChannelUsed,
    refundCommissionPerReturn: row.refundCommissionPerReturn,
    returnPenaltyFractionPercent: row.returnPenaltyFractionPercent,
    returnRecoverable: row.returnRecoverable,
    repackagingCost: row.repackagingCost,
    tcsPercent: row.tcsPercent,
    tcsAmount: row.tcsAmount,
    amazonSettlementEstimate: row.amazonSettlementEstimate,
    realCashToday: row.realCashToday,
    realAdSpendPerUnit: row.realAdSpendPerUnit,
    realAdSpendWindowDays: row.realAdSpendWindowDays,
    realAdSpendDataAvailable: row.realAdSpendDataAvailable,
    realNetProfitAfterAds: row.realNetProfitAfterAds,
    realProfitMarginPercent: row.realProfitMarginPercent
  };
}

function buildContextNotes(body: z.infer<typeof productEconomicsBodySchema>): string | null {
  const lines = [
    body.notes,
    `Shipping Region: ${body.shippingRegion}`,
    `Category Exception: ${body.categoryException ? "Yes" : "No"}`,
    body.fulfillmentType ? `Fulfillment Type: ${body.fulfillmentType}` : "",
    body.productType ? `Product Type: ${body.productType}` : "",
    (body.subcategoryOverride ?? body.subCategory) ? `Subcategory: ${body.subcategoryOverride ?? body.subCategory}` : "",
    body.weightKg !== undefined ? `Weight kg: ${body.weightKg}` : "",
    body.volumeCuFt !== undefined ? `Volume cu ft: ${body.volumeCuFt}` : ""
  ].filter(Boolean);

  return lines.length ? lines.join("\n") : null;
}

export async function postProductEconomics(req: Request, res: Response): Promise<void> {
  const parsed = productEconomicsBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the product economics input values.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
    return;
  }

  try {
    const body = parsed.data;
    const row = await saveProductEconomics({
      ...body,
      subCategory: body.subcategoryOverride ?? body.subCategory,
      landedCost: body.productCost ?? body.buyingCost ?? body.landedCost,
      shippingFeeEstimate: 0,
      amazonFeeEstimate: 0,
      otherCostPerUnit: body.otherFees ?? 0,
      targetProfit: body.requiredProfit ?? body.targetProfit,
      notes: buildContextNotes(body)
    });
    const explanation = buildProductEconomicsExplanation(row);

    res.json({
      ok: true,
      economics: toFounderEconomics(row),
      row,
      explanation
    });
  } catch {
    sendProductEconomicsError(res, "Could not save product economics in Supabase.");
  }
}

export async function getProductEconomicsCostCompletionQueue(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const rows = await getCostCompletionQueue(sellerId);

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendProductEconomicsError(res, "Could not load cost completion queue from Supabase.");
  }
}

export async function getProductEconomics(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const rows = await listProductEconomics(sellerId);

    res.json({
      ok: true,
      sellerId,
      rows
    });
  } catch {
    sendProductEconomicsError(res, "Could not load product economics from Supabase.");
  }
}

export async function getProductEconomicsCostReductionOpportunities(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const report = await getCostReductionOpportunities(sellerId);

    res.json({
      ok: true,
      ...report
    });
  } catch {
    sendProductEconomicsError(res, "Could not load cost reduction opportunities from Supabase.");
  }
}

export async function getProductEconomicsProfitGuardrail(req: Request, res: Response): Promise<void> {
  const id = req.params.id;

  try {
    const row = await getProductEconomicsById(id);

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Product economics row was not found."
      });
      return;
    }

    res.json({
      ok: true,
      id,
      profitGuardrail: buildProductEconomicsExplanation(row)
    });
  } catch {
    sendProductEconomicsError(res, "Could not load product profit guardrail from Supabase.");
  }
}

export async function getProductEconomicsMeasuredReturnRates(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const products = await getMeasuredReturnRates(sellerId);
    res.json({
      ok: true,
      lookbackDays: RETURN_LOOKBACK_DAYS,
      minUnitsForVerdict: RETURN_MIN_UNITS,
      riskThresholdPercent: RETURN_RISK_RATE_PCT,
      products
    });
  } catch {
    sendProductEconomicsError(res, "Could not load measured return rates from Supabase.");
  }
}

export async function getProductEconomicsReturnRatePreview(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const preview = await getReturnRatePreview(sellerId);
    res.json({ ok: true, readOnly: true, ...preview });
  } catch {
    sendProductEconomicsError(res, "Could not build the return-rate preview.");
  }
}

export async function postProductEconomicsReturnRateApply(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, ...(await applyReturnRateSwitch(getSellerIdFromQuery(req))) });
  } catch {
    sendProductEconomicsError(res, "Could not apply the measured return rate.");
  }
}

export async function postProductEconomicsReturnRateUndo(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, ...(await undoReturnRateSwitch(getSellerIdFromQuery(req))) });
  } catch {
    sendProductEconomicsError(res, "Could not undo the measured return rate.");
  }
}
