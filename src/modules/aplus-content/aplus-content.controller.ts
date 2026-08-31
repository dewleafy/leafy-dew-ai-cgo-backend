import { Request, Response } from "express";
import { getAplusContentPreview } from "./aplus-content.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function getAplusContentPreviewRoute(req: Request, res: Response): Promise<void> {
  const asin = typeof req.query.asin === "string" ? req.query.asin.trim() : "";
  const forceRefresh = req.query.refresh === "true" || req.query.refresh === "1";

  if (!asin) {
    res.status(400).json({ ok: false, message: "An asin query parameter is required." });
    return;
  }

  try {
    const report = await getAplusContentPreview({ sellerId: sellerIdFromQuery(req), asin, forceRefresh });
    res.json(report);
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not load A+ Content. Run amazon_aplus_content_cache.sql in Supabase and check the Amazon SP-API connection."
    });
  }
}
