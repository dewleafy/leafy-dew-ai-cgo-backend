import { Request, Response } from "express";
import { z } from "zod";
import {
  CompetitorBenchmarkError,
  MAX_OWN_SKUS,
  confirmCompetitorBenchmarkCandidates,
  createCompetitorBenchmarkRun,
  getCompetitorBenchmarkRun,
  listCompetitorBenchmarkRuns,
  requestCompetitorBenchmarkImageMockup,
  runCompetitorBenchmarkComparison
} from "./competitor-benchmark.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function sendCompetitorBenchmarkError(res: Response, error: unknown): void {
  if (error instanceof CompetitorBenchmarkError) {
    res.status(error.status).json({ ok: false, message: error.message });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({ ok: false, message: error.errors[0]?.message ?? "Invalid request.", details: error.errors });
    return;
  }

  res.status(503).json({
    ok: false,
    message: error instanceof Error ? error.message : "Could not complete this competitor benchmark request.",
    safeHint: "Run competitor_benchmark.sql in Supabase and check the service role key."
  });
}

const createRunBodySchema = z.object({
  skus: z
    .array(z.string().trim().min(1))
    .min(1, "At least one SKU is required.")
    .max(MAX_OWN_SKUS, `A maximum of ${MAX_OWN_SKUS} SKUs is allowed per run.`)
});

export async function postCompetitorBenchmarkRun(req: Request, res: Response): Promise<void> {
  try {
    const body = createRunBodySchema.parse(req.body);
    const sellerId = getSellerIdFromQuery(req);
    const result = await createCompetitorBenchmarkRun({ sellerId, skus: body.skus });
    res.status(201).json({ ok: true, run: result.run, skippedSkus: result.skippedSkus });
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}

export async function getCompetitorBenchmarkRuns(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = getSellerIdFromQuery(req);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const runs = await listCompetitorBenchmarkRuns({ sellerId, limit });
    res.json({ ok: true, rows: runs });
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}

export async function getCompetitorBenchmarkRunById(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = getSellerIdFromQuery(req);
    const run = await getCompetitorBenchmarkRun({ id: req.params.id, sellerId });
    if (!run) {
      res.status(404).json({ ok: false, message: "Competitor benchmark run not found." });
      return;
    }
    res.json({ ok: true, run });
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}

const confirmCandidatesBodySchema = z.object({
  ownSku: z.string().trim().min(1, "ownSku is required."),
  confirmedAsins: z.array(z.string()).default([]),
  removedAsins: z.array(z.string()).default([]),
  addedAsins: z.array(z.string()).default([])
});

export async function postCompetitorBenchmarkConfirmCandidates(req: Request, res: Response): Promise<void> {
  try {
    const body = confirmCandidatesBodySchema.parse(req.body);
    const sellerId = getSellerIdFromQuery(req);
    const run = await confirmCompetitorBenchmarkCandidates({
      runId: req.params.id,
      sellerId,
      ownSku: body.ownSku,
      confirmedAsins: body.confirmedAsins,
      removedAsins: body.removedAsins,
      addedAsins: body.addedAsins
    });
    res.json({ ok: true, run });
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}

export async function postCompetitorBenchmarkCompare(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = getSellerIdFromQuery(req);
    const run = await runCompetitorBenchmarkComparison({ runId: req.params.id, sellerId });
    res.json({ ok: true, run });
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}

export async function getCompetitorBenchmarkImageBrief(req: Request, res: Response): Promise<void> {
  try {
    const sellerId = getSellerIdFromQuery(req);
    const run = await getCompetitorBenchmarkRun({ id: req.params.id, sellerId });
    if (!run) {
      res.status(404).json({ ok: false, message: "Competitor benchmark run not found." });
      return;
    }
    const skuGroup = run.skus.find((s) => s.ownSku === req.params.sku);
    if (!skuGroup) {
      res.status(404).json({ ok: false, message: "No such SKU in this run." });
      return;
    }
    res.json({ ok: true, imageBrief: skuGroup.imageBrief, findings: skuGroup.findings });
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}

const imageMockupBodySchema = z.object({
  ownSku: z.string().trim().min(1, "ownSku is required."),
  imageSlot: z.coerce.number().int().min(1).max(9).default(1)
});

export async function postCompetitorBenchmarkImageMockup(req: Request, res: Response): Promise<void> {
  try {
    const body = imageMockupBodySchema.parse(req.body);
    const sellerId = getSellerIdFromQuery(req);
    const result = await requestCompetitorBenchmarkImageMockup({
      runId: req.params.id,
      sellerId,
      ownSku: body.ownSku,
      imageSlot: body.imageSlot
    });
    res.json(result);
  } catch (error) {
    sendCompetitorBenchmarkError(res, error);
  }
}
