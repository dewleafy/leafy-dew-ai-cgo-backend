import { Request, Response } from "express";
import { z } from "zod";
import {
  bulkUpdateProductPassportCostCompletion,
  getProductPassportCostCompletionSummary,
  listProductPassportCostCompletionRows,
  resolveProductPassportCostActions
} from "./product-passports-cost-completion.service";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const nullableNumberSchema = z.preprocess((value) => {
  return value === "" || value === undefined ? undefined : value;
}, z.union([z.coerce.number().min(0), z.null()]).optional());

const bulkItemSchema = z.object({
  sku: nullableTextSchema,
  asin: nullableTextSchema,
  productCost: nullableNumberSchema,
  landedCost: nullableNumberSchema,
  packagingCost: nullableNumberSchema,
  shippingCost: nullableNumberSchema,
  otherCost: nullableNumberSchema,
  requiredProfit: nullableNumberSchema,
  subcategory: nullableTextSchema
}).refine((item) => item.sku || item.asin, {
  message: "sku or asin is required.",
  path: ["sku"]
});

const bulkUpdateSchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  items: z.array(bulkItemSchema).min(1).max(100),
  autoResolveActions: z.boolean().optional().default(false)
});

const resolveActionsSchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  sku: z.string().trim().min(1, "sku is required.")
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getLimitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
  return Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 200;
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the Product Passport cost completion input values.",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
}

function sendCostCompletionError(res: Response, message: string): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Check product_passports, amazon_sp_listings, amazon_product_economics, and action_ledger tables in Supabase."
  });
}

export async function getProductPassportCostCompletion(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const limit = getLimitFromQuery(req);

  try {
    const rows = await listProductPassportCostCompletionRows({
      sellerId,
      limit,
      onlyNeedingCompletion: true
    });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendCostCompletionError(res, "Could not load Product Passport cost completion rows from Supabase.");
  }
}

export async function postProductPassportCostCompletionBulkUpdate(req: Request, res: Response): Promise<void> {
  const parsed = bulkUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const result = await bulkUpdateProductPassportCostCompletion(parsed.data);
    res.json(result);
  } catch {
    sendCostCompletionError(res, "Could not update Product Passport cost data in Supabase.");
  }
}

export async function postProductPassportCostCompletionResolveActions(req: Request, res: Response): Promise<void> {
  const parsed = resolveActionsSchema.safeParse(req.body);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const result = await resolveProductPassportCostActions(parsed.data);
    res.json(result);
  } catch {
    sendCostCompletionError(res, "Could not resolve Product Passport cost-data action ledger rows.");
  }
}

export async function getProductPassportCostCompletionSummaryController(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const summary = await getProductPassportCostCompletionSummary(sellerId);
    res.json(summary);
  } catch {
    sendCostCompletionError(res, "Could not load Product Passport cost completion summary from Supabase.");
  }
}
