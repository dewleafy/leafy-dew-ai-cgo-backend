import { Request, Response } from "express";
import { listAiRecommendations } from "./recommendations.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getStatusFromQuery(req: Request): string | undefined {
  return typeof req.query.status === "string" && req.query.status.trim()
    ? req.query.status.trim()
    : undefined;
}

function getLimitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;

  return Math.min(Math.max(limit, 1), 500);
}

export async function getRecommendations(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const rows = await listAiRecommendations({
      sellerId,
      status: getStatusFromQuery(req),
      limit: getLimitFromQuery(req)
    });

    res.json({
      ok: true,
      sellerId,
      rows
    });
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not load recommendations from Supabase.",
      safeHint: "Run ai_recommendations.sql in Supabase and check the service role key."
    });
  }
}
