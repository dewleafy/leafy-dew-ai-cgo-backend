import { Request, Response } from "express";
import { buildLearningSummary } from "./learning-summary.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getDaysFromQuery(req: Request): number {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 30;
  const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : 30;
  return Math.min(Math.max(days, 1), 90);
}

export async function getLearningSummary(req: Request, res: Response): Promise<void> {
  try {
    const summary = await buildLearningSummary({
      sellerId: getSellerIdFromQuery(req),
      days: getDaysFromQuery(req)
    });

    res.json(summary);
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not load learning summary from Supabase.",
      safeHint: "Check ai_recommendations, experiments, recommendation_outcomes tables and the service role key."
    });
  }
}
