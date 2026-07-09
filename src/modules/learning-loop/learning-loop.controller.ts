import { Request, Response } from "express";
import { z } from "zod";
import {
  getEngineLearning,
  listEngineLearningSummaries,
  listLearningEvents,
  rebuildLearningSummaries,
  recordLearningEvent
} from "./learning-loop.service";
import { LearningEventType } from "./learning-loop.types";

const learningEventTypes: LearningEventType[] = [
  "ACTION_CREATED",
  "ACTION_APPROVED",
  "ACTION_REJECTED",
  "ACTION_MONITORING",
  "ACTION_COMPLETED",
  "ACTION_REOPENED",
  "COST_DATA_AUTO_RESOLVED",
  "ENGINE_PREVIEW_ACTION_CREATED",
  "ENGINE_PREVIEW_NO_ACTION",
  "ENGINE_SKIPPED_NO_DATA",
  "ENGINE_SKIPPED_TEMPLATE_NOT_IMPLEMENTED",
  "ENGINE_FAILED",
  "DUPLICATE_ACTION_SKIPPED",
  "MANUAL_OUTCOME_NOTE",
  "SHADOW_EXECUTION_PREVIEWED",
  "SHADOW_EXECUTION_COMPLETED",
  "LIVE_EXECUTION_BLOCKED",
  "SHADOW_EXECUTION_FAILED",
  "LISTING_DRAFT_CREATED",
  "IMAGE_A_PLUS_RECOMMENDATION_CREATED"
];

const manualNoteSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  actionId: z.string().trim().uuid().optional().nullable(),
  engineKey: z.string().trim().min(1).optional().nullable(),
  eventType: z.enum(learningEventTypes as [LearningEventType, ...LearningEventType[]]).default("MANUAL_OUTCOME_NOTE"),
  note: z.string().trim().min(1),
  actor: z.string().trim().min(1).optional().default("founder")
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  return Math.min(Math.max(limit, 1), 500);
}

function sendDbError(res: Response): void {
  res.status(503).json({
    ok: false,
    message: "Could not load Learning Loop data. Run learning_loop.sql in Supabase and check service role access."
  });
}

export async function getLearningLoopSummaryRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listEngineLearningSummaries(sellerId);
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendDbError(res);
  }
}

export async function getLearningLoopEventsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listLearningEvents({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendDbError(res);
  }
}

export async function getLearningLoopEngineRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const engineKey = req.params.engineKey?.trim();

  if (!engineKey) {
    res.status(400).json({ ok: false, message: "engineKey is required." });
    return;
  }

  try {
    const result = await getEngineLearning({ sellerId, engineKey });
    res.json({ ok: true, sellerId, engineKey, ...result });
  } catch {
    sendDbError(res);
  }
}

export async function rebuildLearningLoopRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const result = await rebuildLearningSummaries(sellerId);
    res.json({ ok: true, ...result });
  } catch {
    sendDbError(res);
  }
}

export async function postManualLearningNoteRoute(req: Request, res: Response): Promise<void> {
  const parsed = manualNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the manual learning note input.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return;
  }

  try {
    const row = await recordLearningEvent({
      sellerId: parsed.data.sellerId,
      actionId: parsed.data.actionId,
      engineKey: parsed.data.engineKey,
      eventType: parsed.data.eventType,
      note: parsed.data.note,
      actor: parsed.data.actor,
      metadata: { manualNote: true }
    });
    res.json({ ok: true, row });
  } catch {
    sendDbError(res);
  }
}
