import { Request, Response } from "express";
import {
  getListingReadinessByProductPassportId,
  getListingReadinessSummary
} from "./listing-readiness.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function sendListingReadinessError(res: Response, message: string): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Check product_passports and amazon_product_economics tables in Supabase."
  });
}

export async function getListingReadiness(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const result = await getListingReadinessSummary(sellerId);

    res.json(result);
  } catch {
    sendListingReadinessError(res, "Could not load listing readiness from Supabase.");
  }
}

export async function getListingReadinessDetail(req: Request, res: Response): Promise<void> {
  try {
    const result = await getListingReadinessByProductPassportId(req.params.productPassportId);

    if (!result) {
      res.status(404).json({
        ok: false,
        message: "Product passport was not found."
      });
      return;
    }

    res.json(result);
  } catch {
    sendListingReadinessError(res, "Could not load listing readiness detail from Supabase.");
  }
}
