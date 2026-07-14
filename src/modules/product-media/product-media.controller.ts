import { Request, Response } from "express";
import { z } from "zod";
import {
  getProductMediaDebug,
  saveManualProductMedia,
  syncCatalogImages
} from "./product-media.service";

const manualProductMediaSchema = z.object({
  sellerId: z.string().trim().min(1).optional().nullable(),
  sku: z.string().trim().min(1).optional().nullable(),
  asin: z.string().trim().min(1).optional().nullable(),
  productName: z.string().trim().min(1).optional().nullable(),
  mainImageUrl: z.string().trim().min(1),
  imageUrls: z.array(z.unknown()).optional().default([])
});

function getSellerId(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getLimit(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20;
  return Math.min(Math.max(limit, 1), 100);
}

function getTextQuery(req: Request, key: string): string | null {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getForce(req: Request): boolean {
  return typeof req.query.force === "string" && req.query.force.toLowerCase() === "true";
}

export async function getProductMediaDebugController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getProductMediaDebug({
      sellerId: getSellerId(req),
      limit: getLimit(req),
      asin: getTextQuery(req, "asin"),
      sku: getTextQuery(req, "sku")
    }));
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not inspect product media fields.",
      safeHint: "Check product_media, product_passports, and amazon_sp_listings access in Supabase.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function postProductMediaCatalogSyncController(req: Request, res: Response): Promise<void> {
  try {
    const result = await syncCatalogImages({
      sellerId: getSellerId(req),
      limit: getLimit(req),
      asin: getTextQuery(req, "asin"),
      sku: getTextQuery(req, "sku"),
      force: getForce(req)
    });

    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not sync Amazon Catalog product images.",
      safeHint: "Check SP-API Catalog permissions and product_media table access.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function postManualProductMediaController(req: Request, res: Response): Promise<void> {
  const parsed = manualProductMediaSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the manual product media input values.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
    return;
  }

  try {
    res.json(await saveManualProductMedia(parsed.data));
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not save manual product media.",
      safeHint: "Provide sellerId plus sku or asin, and a valid mainImageUrl."
    });
  }
}
