import { Request, Response } from "express";
import { z } from "zod";
import {
  dryRunLiveExecution,
  executeLiveExecution,
  getLiveExecutionForAction,
  getLiveExecutionStatus,
  listLiveExecutionRuns,
  preflightLiveExecution
} from "./live-execution.service";

const executionBodySchema = z.object({
  sellerId: z.string().nullable().optional(),
  actor: z.string().nullable().optional(),
  confirmText: z.string().nullable().optional(),
  requestPayload: z.record(z.string(), z.unknown()).optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const raw = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 500) : fallback;
}

function parseBody(req: Request, res: Response) {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check live execution input.", issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

export async function getLiveExecutionStatusRoute(req: Request, res: Response): Promise<void> {
  res.json(await getLiveExecutionStatus(sellerIdFromQuery(req)));
}

export async function preflightLiveExecutionRoute(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, res);
  if (!body) return;
  res.json(await preflightLiveExecution(req.params.actionId, { ...body, sellerId: body.sellerId ?? sellerIdFromQuery(req) }));
}

export async function dryRunLiveExecutionRoute(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, res);
  if (!body) return;
  res.json(await dryRunLiveExecution(req.params.actionId, { ...body, sellerId: body.sellerId ?? sellerIdFromQuery(req) }));
}

export async function executeLiveExecutionRoute(req: Request, res: Response): Promise<void> {
  const body = parseBody(req, res);
  if (!body) return;
  res.json(await executeLiveExecution(req.params.actionId, { ...body, sellerId: body.sellerId ?? sellerIdFromQuery(req) }));
}

export async function listLiveExecutionRunsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const actionId = typeof req.query.actionId === "string" ? req.query.actionId : undefined;
  const rows = await listLiveExecutionRuns({ sellerId, actionId, limit: limitFromQuery(req) });
  res.json({ ok: true, sellerId, count: rows.length, rows });
}

export async function getLiveExecutionForActionRoute(req: Request, res: Response): Promise<void> {
  res.json(await getLiveExecutionForAction(req.params.actionId, sellerIdFromQuery(req)));
}
