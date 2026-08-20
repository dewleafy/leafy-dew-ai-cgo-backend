import { Request, Response } from "express";
import { checkListingSchemaReadiness } from "./listing-schema.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function checkListingSchemaReadinessRoute(req: Request, res: Response): Promise<void> {
  const sku = typeof req.query.sku === "string" ? req.query.sku.trim() : "";

  if (!sku) {
    res.status(400).json({ ok: false, message: "A sku query parameter is required." });
    return;
  }

  try {
    const report = await checkListingSchemaReadiness({ sellerId: sellerIdFromQuery(req), sku });
    res.json(report);
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not check Amazon schema readiness. Run amazon_schema_cache.sql in Supabase and check the Amazon SP-API connection."
    });
  }
}
