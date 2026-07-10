import { Request, Response } from "express";
import { getLatestQaSmokeRun, listQaSmokeRuns, runQaSmokeTest } from "./qa-smoke.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 20): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  return Math.min(Math.max(limit, 1), 50);
}

function sendQaError(res: Response): void {
  res.status(503).json({
    ok: false,
    message: "Could not use QA Smoke Runner. Run qa_smoke_tests.sql and check service role access."
  });
}

export async function runQaSmokeRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await runQaSmokeTest(sellerIdFromQuery(req)));
  } catch {
    sendQaError(res);
  }
}

export async function listQaSmokeRunsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listQaSmokeRuns({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendQaError(res);
  }
}

export async function getLatestQaSmokeRunRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getLatestQaSmokeRun(sellerIdFromQuery(req)));
  } catch {
    sendQaError(res);
  }
}
