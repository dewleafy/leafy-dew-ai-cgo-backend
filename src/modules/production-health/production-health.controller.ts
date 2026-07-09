import { Request, Response } from "express";
import { getProductionHealthSummary } from "./production-health.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function getProductionHealthSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getProductionHealthSummary(sellerIdFromQuery(req)));
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not build Production Health summary."
    });
  }
}
