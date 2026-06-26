import { Request, Response } from "express";
import { getBrandReadiness } from "./brand-readiness.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

export async function getBrandReadinessController(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const result = await getBrandReadiness(sellerId);

    res.json(result);
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not load brand readiness from Supabase.",
      safeHint: "Check product_passports table and service role key."
    });
  }
}
