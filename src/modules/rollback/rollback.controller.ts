import { Request, Response } from "express";
import { z } from "zod";
import {
  captureRollbackSnapshot,
  executeRollbackSnapshot,
  getRollbackSummary,
  listRollbackSnapshots,
  previewRollbackSnapshot
} from "./rollback.service";

const captureBodySchema = z.object({
  sellerId: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional().default("founder"),
  sourceModule: z.string().trim().min(1).optional(),
  notes: z.string().trim().optional().nullable(),
  plannedChange: z.record(z.string(), z.unknown()).optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  return Math.min(Math.max(limit, 1), 500);
}

function sendRollbackError(res: Response, error: unknown): void {
  if (error instanceof Error && error.message === "ACTION_NOT_FOUND") {
    res.status(404).json({ ok: false, message: "Action ledger row not found." });
    return;
  }

  if (error instanceof Error && error.message === "SNAPSHOT_NOT_FOUND") {
    res.status(404).json({ ok: false, message: "Rollback snapshot not found." });
    return;
  }

  res.status(503).json({
    ok: false,
    message: "Could not use rollback snapshots. Run rollback_snapshots.sql in Supabase and check service role access."
  });
}

export async function getRollbackSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getRollbackSummary(sellerIdFromQuery(req)));
  } catch (error) {
    sendRollbackError(res, error);
  }
}

export async function listRollbackSnapshotsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listRollbackSnapshots({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch (error) {
    sendRollbackError(res, error);
  }
}

export async function listRollbackSnapshotsForActionRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const actionId = String(req.params.actionId || "").trim();
  try {
    const rows = await listRollbackSnapshots({ sellerId, actionId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, actionId, count: rows.length, rows });
  } catch (error) {
    sendRollbackError(res, error);
  }
}

export async function captureRollbackSnapshotRoute(req: Request, res: Response): Promise<void> {
  const parsed = captureBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check rollback capture input.", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(await captureRollbackSnapshot({
      actionId: String(req.params.actionId || "").trim(),
      sellerId: parsed.data.sellerId ?? sellerIdFromQuery(req),
      capturedBy: parsed.data.actor,
      sourceModule: parsed.data.sourceModule,
      notes: parsed.data.notes,
      plannedChange: parsed.data.plannedChange
    }));
  } catch (error) {
    sendRollbackError(res, error);
  }
}

export async function previewRollbackSnapshotRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await previewRollbackSnapshot(String(req.params.snapshotId || "").trim()));
  } catch (error) {
    sendRollbackError(res, error);
  }
}

export async function executeRollbackSnapshotRoute(req: Request, res: Response): Promise<void> {
  res.json(await executeRollbackSnapshot(String(req.params.snapshotId || "").trim()));
}
