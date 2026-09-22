import { Request, Response } from "express";
import { z } from "zod";
import {
  archiveProductPassport,
  bulkApplyStandardComplianceNotes,
  bulkApplyTestTubePlanterPackageContents,
  createProductPassport,
  getProductPassportById,
  isProductPassportStatus,
  listProductPassports,
  updateProductPassport
} from "./product-passports.service";
import {
  getProductPassportReadinessById,
  getProductPassportReadinessSummary
} from "./product-passports-readiness.service";
import { ProductPassportStatus } from "./product-passports.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const arraySchema = z.array(z.unknown()).optional().default([]);
const statusSchema = z
  .string()
  .optional()
  .transform((value, context) => {
    if (!value) {
      return undefined;
    }

    if (!isProductPassportStatus(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status must be DRAFT, ACTIVE, NEEDS_REVIEW, or ARCHIVED."
      });
      return z.NEVER;
    }

    return value;
  });

const productPassportCreateSchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  sku: nullableTextSchema,
  asin: nullableTextSchema,
  productName: z.string().trim().min(1, "productName is required."),
  brand: nullableTextSchema,
  category: nullableTextSchema,
  subCategory: nullableTextSchema,
  productType: nullableTextSchema,
  sellingPrice: z.coerce.number().min(0).optional().nullable(),
  targetCustomer: nullableTextSchema,
  useCase: nullableTextSchema,
  material: nullableTextSchema,
  color: nullableTextSchema,
  dimensions: nullableTextSchema,
  weight: nullableTextSchema,
  packageContents: nullableTextSchema,
  keyFeatures: arraySchema,
  customerObjections: arraySchema,
  competitorAsins: arraySchema,
  imageUrls: arraySchema,
  supplierName: nullableTextSchema,
  supplierCost: z.coerce.number().min(0).optional().nullable(),
  packagingNotes: nullableTextSchema,
  brandPositioning: nullableTextSchema,
  seoKeywords: arraySchema,
  complianceNotes: nullableTextSchema,
  internalNotes: nullableTextSchema,
  status: statusSchema.default("DRAFT" as ProductPassportStatus)
});

const productPassportUpdateSchema = productPassportCreateSchema.partial().extend({
  productName: z.string().trim().min(1, "productName cannot be empty.").optional()
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getStatusFromQuery(req: Request): ProductPassportStatus | undefined {
  if (typeof req.query.status !== "string" || !req.query.status.trim()) {
    return undefined;
  }

  return isProductPassportStatus(req.query.status) ? req.query.status : undefined;
}

function getLimitFromQuery(req: Request): number | undefined {
  if (typeof req.query.limit !== "string" || !req.query.limit.trim()) return undefined;
  const rawLimit = Number(req.query.limit);
  if (!Number.isFinite(rawLimit)) return undefined;
  return Math.min(Math.max(Math.floor(rawLimit), 1), 500);
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the product passport input values.",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
}

function sendDatabaseError(res: Response, message: string): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run product_passports.sql in Supabase and check the service role key."
  });
}

export async function getProductPassports(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawStatus = typeof req.query.status === "string" && req.query.status.trim() ? req.query.status : undefined;
  const status = getStatusFromQuery(req);

  if (rawStatus && !status) {
    res.status(400).json({
      ok: false,
      message: "status must be DRAFT, ACTIVE, NEEDS_REVIEW, or ARCHIVED."
    });
    return;
  }

  try {
    const rows = await listProductPassports({ sellerId, status, limit: getLimitFromQuery(req) });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load product passports from Supabase.");
  }
}

export async function getProductPassport(req: Request, res: Response): Promise<void> {
  try {
    const row = await getProductPassportById(req.params.id);

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Product passport was not found."
      });
      return;
    }

    res.json({
      ok: true,
      row
    });
  } catch {
    sendDatabaseError(res, "Could not load product passport from Supabase.");
  }
}

export async function getProductPassportReadiness(req: Request, res: Response): Promise<void> {
  try {
    const readiness = await getProductPassportReadinessById(req.params.id);

    if (!readiness) {
      res.status(404).json({
        ok: false,
        message: "Product passport was not found."
      });
      return;
    }

    res.json(readiness);
  } catch {
    sendDatabaseError(res, "Could not load product passport readiness from Supabase.");
  }
}

export async function getProductPassportReadinessSummaryController(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const summary = await getProductPassportReadinessSummary(sellerId);

    res.json(summary);
  } catch {
    sendDatabaseError(res, "Could not load product passport readiness summary from Supabase.");
  }
}

export async function postProductPassport(req: Request, res: Response): Promise<void> {
  const parsed = productPassportCreateSchema.safeParse(req.body);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await createProductPassport(parsed.data);

    res.json({
      ok: true,
      row
    });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes("already exists") ? 409 : 503).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not create product passport.",
      safeHint: "Check product_passports table and unique seller SKU/ASIN values."
    });
  }
}

// Founder-triggered, one-click bulk write -- deliberately separate from the AI drafting/Approval
// Center pipeline (see EXTRACTION_ONLY_DRAFT_TYPES in listing-drafts.service.ts). This never
// invents anything: it saves back the exact statement the founder confirmed in chat, and only
// touches products that don't already have a compliance_notes value.
export async function postProductPassportBulkComplianceNotesRoute(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawText = typeof (req.body as { text?: unknown } | undefined)?.text === "string" ? (req.body as { text: string }).text : undefined;

  try {
    const result = await bulkApplyStandardComplianceNotes({ sellerId, text: rawText });
    res.json({ ok: true, sellerId, ...result });
  } catch (error) {
    sendDatabaseError(res, error instanceof Error ? error.message : "Could not apply compliance notes in bulk.");
  }
}

// Founder-triggered, one-click bulk write scoped to the Test Tube Planter wall-hanging family --
// see bulkApplyTestTubePlanterPackageContents for the founder confirmation and the exact name-match
// scoping. Only touches products that don't already have a package_contents value.
export async function postProductPassportBulkPackageContentsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawText = typeof (req.body as { text?: unknown } | undefined)?.text === "string" ? (req.body as { text: string }).text : undefined;

  try {
    const result = await bulkApplyTestTubePlanterPackageContents({ sellerId, text: rawText });
    res.json({ ok: true, sellerId, ...result });
  } catch (error) {
    sendDatabaseError(res, error instanceof Error ? error.message : "Could not apply package contents in bulk.");
  }
}

export async function putProductPassport(req: Request, res: Response): Promise<void> {
  const parsed = productPassportUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await updateProductPassport({
      id: req.params.id,
      updates: parsed.data
    });

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Product passport was not found."
      });
      return;
    }

    res.json({
      ok: true,
      row
    });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes("already exists") ? 409 : 503).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not update product passport.",
      safeHint: "Check product_passports table and unique seller SKU/ASIN values."
    });
  }
}

export async function deleteProductPassport(req: Request, res: Response): Promise<void> {
  try {
    const row = await archiveProductPassport(req.params.id);

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Product passport was not found."
      });
      return;
    }

    res.json({
      ok: true,
      row
    });
  } catch {
    sendDatabaseError(res, "Could not archive product passport in Supabase.");
  }
}
