import { Request, Response } from "express";
import { z } from "zod";
import {
  executeLive,
  executeShadow,
  getExecutionGatewayStatus,
  listExecutionAttempts,
  previewExecution
} from "./execution-gateway.service";

const executionBodySchema = z.object({
  actor: z.string().trim().min(1).optional().default("founder"),
  requestPayload: z.record(z.string(), z.unknown()).optional().default({})
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 50): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  return Math.min(Math.max(limit, 1), 200);
}

function actionIdFromParams(req: Request): string {
  return String(req.params.actionId || "").trim();
}

function sendExecutionError(res: Response, error: unknown): void {
  if (error instanceof Error && error.message === "ACTION_NOT_FOUND") {
    res.status(404).json({ ok: false, message: "Action ledger row not found." });
    return;
  }

  res.status(503).json({
    ok: false,
    message: "Could not use Execution Gateway. Run execution_gateway.sql in Supabase and check service role access."
  });
}

export async function getExecutionGatewayStatusRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getExecutionGatewayStatus(sellerIdFromQuery(req)));
  } catch {
    res.json({
      ok: true,
      sellerId: sellerIdFromQuery(req),
      mode: "SHADOW_ONLY",
      liveExecutionEnabled: false,
      aiCallsEnabled: false,
      message: "Live execution is blocked. Shadow execution only."
    });
  }
}

export async function previewExecutionRoute(req: Request, res: Response): Promise<void> {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check execution input.", issues: parsed.error.issues });
    return;
  }

  try {
    const result = await previewExecution({
      actionId: actionIdFromParams(req),
      actor: parsed.data.actor,
      requestPayload: parsed.data.requestPayload
    });
    res.json(result);
  } catch (error) {
    sendExecutionError(res, error);
  }
}

export async function executeShadowRoute(req: Request, res: Response): Promise<void> {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check execution input.", issues: parsed.error.issues });
    return;
  }

  try {
    const result = await executeShadow({
      actionId: actionIdFromParams(req),
      actor: parsed.data.actor,
      requestPayload: parsed.data.requestPayload
    });
    res.json(result);
  } catch (error) {
    sendExecutionError(res, error);
  }
}

export async function executeLiveRoute(req: Request, res: Response): Promise<void> {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check execution input.", issues: parsed.error.issues });
    return;
  }

  try {
    const result = await executeLive({
      actionId: actionIdFromParams(req),
      actor: parsed.data.actor,
      requestPayload: parsed.data.requestPayload
    });
    res.json(result);
  } catch (error) {
    sendExecutionError(res, error);
  }
}

export async function listExecutionAttemptsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listExecutionAttempts({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch (error) {
    sendExecutionError(res, error);
  }
}

export async function listExecutionAttemptsForActionRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const actionId = actionIdFromParams(req);
  try {
    const rows = await listExecutionAttempts({ sellerId, actionId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, actionId, count: rows.length, rows });
  } catch (error) {
    sendExecutionError(res, error);
  }
}
