import { Request, Response } from "express";
import { z } from "zod";
import {
  getSafetyControlSettings,
  initializeSafetyControl,
  listSafetyAuditEvents,
  patchSafetyControlSettings,
  buildSafetySnapshot
} from "./safety-control.service";

const safetyPatchSchema = z.object({
  globalMode: z.string().trim().min(1).optional(),
  liveExecutionEnabled: z.boolean().optional(),
  ppcLiveExecutionEnabled: z.boolean().optional(),
  listingLiveExecutionEnabled: z.boolean().optional(),
  imageLiveExecutionEnabled: z.boolean().optional(),
  aPlusLiveExecutionEnabled: z.boolean().optional(),
  socialLiveExecutionEnabled: z.boolean().optional(),
  aiCallsEnabled: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  founderApprovalRequired: z.boolean().optional(),
  maxDailyEngineRuns: z.number().finite().optional(),
  maxDailyAiCost: z.number().finite().optional(),
  maxDailyExecutionAttempts: z.number().finite().optional(),
  approvalTierRules: z.record(z.string(), z.unknown()).optional(),
  blockedActionTypes: z.array(z.unknown()).optional(),
  safetyNotes: z.string().nullable().optional(),
  actor: z.string().trim().min(1).optional(),
  note: z.string().nullable().optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  return Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : fallback;
}

function sendSafetyDatabaseError(res: Response): void {
  res.status(503).json({
    ok: false,
    message: "Could not use Safety Control. Run safety_control.sql in Supabase and check service role access."
  });
}

export async function getSafetyControlStatusRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const settings = await getSafetyControlSettings(sellerId);
    const snapshot = buildSafetySnapshot(settings);
    res.json({
      ok: true,
      sellerId,
      settings,
      snapshot,
      shadowMode: snapshot.shadowMode,
      liveExecutionEnabled: snapshot.liveExecutionEnabled,
      approvalRequired: snapshot.approvalRequired,
      message: snapshot.message
    });
  } catch {
    sendSafetyDatabaseError(res);
  }
}

export async function initializeSafetyControlRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const result = await initializeSafetyControl(sellerId, "founder");
    res.json({ ok: true, sellerId, ...result });
  } catch {
    sendSafetyDatabaseError(res);
  }
}

export async function patchSafetyControlSettingsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const parsed = safetyPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check safety settings input.", issues: parsed.error.issues });
    return;
  }

  try {
    const result = await patchSafetyControlSettings({ sellerId, patch: parsed.data });
    res.json({
      ok: true,
      sellerId,
      ...result,
      shadowMode: result.snapshot.shadowMode,
      liveExecutionEnabled: result.snapshot.liveExecutionEnabled,
      approvalRequired: result.snapshot.approvalRequired,
      message: result.snapshot.message
    });
  } catch {
    sendSafetyDatabaseError(res);
  }
}

export async function listSafetyAuditEventsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listSafetyAuditEvents({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendSafetyDatabaseError(res);
  }
}
