import { Request, Response } from "express";
import { z } from "zod";
import {
  ListingOptimizerError,
  getListingOptimizerAnalysis,
  listListingOptimizerAnalyses,
  runListingOptimizerAnalysis
} from "./listing-optimizer.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function sendListingOptimizerError(res: Response, error: unknown): void {
  if (error instanceof ListingOptimizerError) {
    res.status(error.status).json({ ok: false, message: error.message });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({ ok: false, message: error.errors[0]?.message ?? "Invalid request.", details: error.errors });
    return;
  }

  res.status(503).json({
    ok: false,
    message: error instanceof Error ? error.message : "Could not complete this Listing Optimizer request.",
    safeHint: "Run listing_optimizer.sql in Supabase and check the service role key."
  });
}

const analyzeBodySchema = z.object({
  sku: z.string().trim().min(1, "sku is required."),
  benchmarkRunId: z.string().trim().min(1).nullish(),
  ownReviewCount: z.coerce.number().int().min(0).nullish(),
  ownRating: z.coerce.number().min(1).max(5).nullish(),
  ownHasVideo: z.boolean().nullish(),
  ownHasLifestyleImage: z.boolean().nullish(),
  ownImageQualityScore: z.coerce.number().min(0).max(1).nullish(),
  highVolumeKeywords: z.array(z.string()).default([]),
  useAiJudging: z.boolean().default(true)
});

export async function postListingOptimizerAnalyze(req: Request, res: Response): Promise<void> {
  try {
    const body = analyzeBodySchema.parse(req.body);
    const sellerId = getSellerIdFromQuery(req);
    const analysis = await runListingOptimizerAnalysis({
      sellerId,
      ownSku: body.sku,
      benchmarkRunId: body.benchmarkRunId ?? null,
      ownReviewCount: body.ownReviewCount ?? null,
      ownRating: body.ownRating ?? null,
      ownHasVideo: body.ownHasVideo ?? null,
      ownHasLifestyleImage: body.ownHasLifestyleImage ?? null,
      ownImageQualityScore: body.ownImageQualityScore ?? null,
      highVolumeKeywords: body.highVolumeKeywords,
      useAiJudging: body.useAiJudging
    });
    res.status(201).json({ ok: true, analysis });
  } catch (error) {
    sendListingOptimizerError(res, error);
  }
}

export async function getListingOptimizerAnalyses(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = getSellerIdFromQuery(req);
    const ownSku = typeof req.query.sku === "string" && req.query.sku.trim() ? req.query.sku.trim() : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = await listListingOptimizerAnalyses({ sellerId, ownSku, limit });
    res.json({ ok: true, rows });
  } catch (error) {
    sendListingOptimizerError(res, error);
  }
}

export async function getListingOptimizerAnalysisById(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = getSellerIdFromQuery(req);
    const analysis = await getListingOptimizerAnalysis({ id: req.params.id, sellerId });
    if (!analysis) {
      res.status(404).json({ ok: false, message: "Listing Optimizer analysis not found." });
      return;
    }
    res.json({ ok: true, analysis });
  } catch (error) {
    sendListingOptimizerError(res, error);
  }
}
