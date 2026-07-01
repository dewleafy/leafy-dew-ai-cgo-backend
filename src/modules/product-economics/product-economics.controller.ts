import { Request, Response } from "express";
import { z } from "zod";
import {
  buildProductEconomicsExplanation,
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

const productEconomicsBodySchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  marketplaceId: nullableTextSchema,
  asin: nullableTextSchema,
  sku: z.string().trim().min(1, "SKU is required."),
  productName: nullableTextSchema,
  subCategory: nullableTextSchema,
  fulfillmentType: nullableTextSchema,
  productType: nullableTextSchema,
  shippingRegion: nullableTextSchema,
  categoryException: nullableTextSchema,
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
    requiredProfit: row.requiredProfit,
    nonAdCost: row.nonAdCost,
    maxAllowableAdSpend: row.maxAllowableAdSpend,
    targetAcos: row.targetAcos,
    breakEvenAcos: row.breakEvenAcos,
    profitStatus: row.profitStatus,
    profitDataStatus: row.profitDataStatus,
    reason: row.reason
  };
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
      landedCost: body.productCost ?? body.buyingCost ?? body.landedCost,
      shippingFeeEstimate: body.shippingCost ?? body.shippingFeeEstimate,
      amazonFeeEstimate: body.referralFee ?? body.amazonFeeEstimate,
      otherCostPerUnit: body.otherFees ?? body.closingFee ?? body.otherCostPerUnit,
      targetProfit: body.requiredProfit ?? body.targetProfit
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
