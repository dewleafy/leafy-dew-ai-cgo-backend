import { Request, Response } from "express";
import { z } from "zod";
import {
  buildProductEconomicsExplanation,
  getCostCompletionQueue,
  getProductEconomicsById,
  listProductEconomics,
  saveProductEconomics
} from "./product-economics.service";

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
  returnRatePercent: z.coerce.number().min(0).default(0),
  returnCostPerReturn: z.coerce.number().min(0).default(0),
  returnReservePerUnit: z.coerce.number().min(0).optional(),
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
    shippingFee: row.shippingCost,
    pickAndPackFee: 0,
    storageFee: 0,
    otherFees: row.otherCostPerUnit,
    totalAmazonFees: row.referralFee + row.shippingCost + row.closingFee,
    gstOnAmazonFees: row.taxEstimate,
    grossProfit: row.sellingPrice - row.buyingCost,
    netProfit: row.sellingPrice - row.nonAdCost,
    profitMarginPercent: row.sellingPrice > 0 ? Math.round(((row.sellingPrice - row.nonAdCost) / row.sellingPrice) * 10000) / 100 : null,
    referralFeePercent: row.sellingPrice > 0 ? Math.round((row.referralFee / row.sellingPrice) * 10000) / 100 : null,
    requiredProfit: row.requiredProfit,
    nonAdCost: row.nonAdCost,
    maxAllowableAdSpend: row.maxAllowableAdSpend,
    targetAcos: row.targetAcos,
    breakEvenAcos: row.breakEvenAcos,
    profitStatus: row.profitStatus,
    profitDataStatus: row.profitDataStatus,
    feeRulesVersion: "legacy_product_economics_v1",
    reason: row.reason
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
      shippingFeeEstimate: body.shippingCost ?? body.shippingFeeEstimate,
      amazonFeeEstimate: body.referralFee ?? body.amazonFeeEstimate,
      otherCostPerUnit: body.otherFees ?? body.closingFee ?? body.otherCostPerUnit,
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
