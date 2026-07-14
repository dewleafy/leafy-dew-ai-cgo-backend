import { Request, Response } from "express";
import { getProductMediaDebug } from "./product-media.service";

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

export async function getProductMediaDebugController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getProductMediaDebug({
      sellerId: getSellerId(req),
      limit: getLimit(req)
    }));
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not inspect product media fields.",
      safeHint: "Check product_passports and amazon_sp_listings access in Supabase."
    });
  }
}
