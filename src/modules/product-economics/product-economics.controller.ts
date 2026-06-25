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
  sku: nullableTextSchema,
  productName: nullableTextSchema,
  sellingPrice: z.coerce.number().min(0, "sellingPrice must be 0 or higher."),
  landedCost: z.coerce.number().min(0).default(0),
  packagingCost: z.coerce.number().min(0).default(0),
  amazonFeeEstimate: z.coerce.number().min(0).default(0),
  shippingFeeEstimate: z.coerce.number().min(0).default(0),
  taxEstimate: z.coerce.number().min(0).default(0),
  returnRatePercent: z.coerce.number().min(0).default(0),
  returnCostPerReturn: z.coerce.number().min(0).default(0),
  returnReservePerUnit: z.coerce.number().min(0).optional(),
  influencerCostAllocationPerUnit: z.coerce.number().min(0).default(0),
  socialMarketingCostPerUnit: z.coerce.number().min(0).default(0),
  couponDiscountEstimate: z.coerce.number().min(0).default(0),
  otherCostPerUnit: z.coerce.number().min(0).default(0),
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
    const row = await saveProductEconomics(parsed.data);
    const explanation = buildProductEconomicsExplanation(row);

    res.json({
      ok: true,
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
