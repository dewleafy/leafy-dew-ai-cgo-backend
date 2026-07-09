import { Request, Response } from "express";
import {
  createActionForCreativeRecommendation,
  generateCreativeRecommendations,
  getCreativeRecommendationSummary,
  listCreativeRecommendations
} from "./creative-recommendations.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  return Math.min(Math.max(limit, 1), 500);
}

function sendCreativeError(res: Response, error?: unknown): void {
  if (error instanceof Error && error.message === "RECOMMENDATION_NOT_FOUND") {
    res.status(404).json({ ok: false, message: "Creative recommendation not found." });
    return;
  }

  res.status(503).json({
    ok: false,
    message: "Could not use Creative Recommendation System. Run creative_recommendations.sql in Supabase and check service role access."
  });
}

export async function getCreativeRecommendationSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getCreativeRecommendationSummary(sellerIdFromQuery(req)));
  } catch (error) {
    sendCreativeError(res, error);
  }
}

export async function listCreativeRecommendationsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listCreativeRecommendations({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch (error) {
    sendCreativeError(res, error);
  }
}

export async function generateCreativeRecommendationsRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await generateCreativeRecommendations(sellerIdFromQuery(req)));
  } catch (error) {
    sendCreativeError(res, error);
  }
}

export async function createCreativeRecommendationActionRoute(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ ok: false, message: "Recommendation id is required." });
    return;
  }

  try {
    const result = await createActionForCreativeRecommendation(id);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendCreativeError(res, error);
  }
}
