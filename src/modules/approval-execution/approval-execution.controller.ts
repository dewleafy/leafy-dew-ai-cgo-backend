import { Request, Response } from "express";
import { z } from "zod";
import {
  getApprovalExecutionSummary,
  listApprovalExecutionReadyActions,
  liveExecuteApprovedAction,
  previewApprovedAction,
  shadowExecuteApprovedAction
} from "./approval-execution.service";

const executionBodySchema = z.object({
  actor: z.string().trim().min(1).optional().default("founder"),
  requestPayload: z.record(z.string(), z.unknown()).optional().default({})
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  return Math.min(Math.max(limit, 1), 200);
}

function actionIdFromParams(req: Request): string {
  return String(req.params.actionId || "").trim();
}

function sendBridgeError(res: Response, error: unknown): void {
  if (error instanceof Error && error.message === "ACTION_NOT_FOUND") {
    res.status(404).json({ ok: false, message: "Action ledger row not found." });
    return;
  }

  if (error instanceof Error && error.message === "ACTION_NOT_READY") {
    res.status(400).json({ ok: false, message: "Action must be approved or monitoring and require approval before execution bridge use." });
    return;
  }

  if (error instanceof Error && error.message === "SAFETY_CHECK_FAILED") {
    res.status(409).json({ ok: false, message: "Safety checks failed. Live execution and AI calls must remain disabled." });
    return;
  }

  res.status(503).json({
    ok: false,
    message: "Could not use Approval-to-Execution Bridge. Check action ledger, execution gateway, and safety tables."
  });
}

export async function getReadyActionsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listApprovalExecutionReadyActions({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch (error) {
    sendBridgeError(res, error);
  }
}

export async function getApprovalExecutionSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getApprovalExecutionSummary(sellerIdFromQuery(req)));
  } catch (error) {
    sendBridgeError(res, error);
  }
}

export async function previewApprovedActionRoute(req: Request, res: Response): Promise<void> {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check bridge input.", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(await previewApprovedAction({ actionId: actionIdFromParams(req), ...parsed.data }));
  } catch (error) {
    sendBridgeError(res, error);
  }
}

export async function shadowExecuteApprovedActionRoute(req: Request, res: Response): Promise<void> {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check bridge input.", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(await shadowExecuteApprovedAction({ actionId: actionIdFromParams(req), ...parsed.data }));
  } catch (error) {
    sendBridgeError(res, error);
  }
}

export async function liveExecuteApprovedActionRoute(req: Request, res: Response): Promise<void> {
  const parsed = executionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check bridge input.", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(await liveExecuteApprovedAction({ actionId: actionIdFromParams(req), ...parsed.data }));
  } catch (error) {
    sendBridgeError(res, error);
  }
}
