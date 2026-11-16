import { Request, Response } from "express";
import { z } from "zod";
import {
  SOCIAL_DRAFT_PLATFORMS,
  SOCIAL_DRAFT_STATUSES,
  createSocialDrafts,
  listSocialDrafts,
  updateSocialDraft
} from "./social-drafts.service";

function getSellerId(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getLimit(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  return Math.min(Math.max(limit, 1), 500);
}

const nullableText = z
  .string()
  .trim()
  .min(1)
  .optional()
  .nullable()
  .transform((value) => value ?? null);

const dateText = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .nullable()
  .transform((value) => value ?? null);

const draftSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  contentLogId: z.string().uuid().optional().nullable().transform((value) => value ?? null),
  plannedDate: dateText,
  slotTime: nullableText,
  platform: z.enum(SOCIAL_DRAFT_PLATFORMS as [string, ...string[]]).optional().default("INSTAGRAM"),
  format: nullableText,
  occasion: nullableText,
  caption: z.string().trim().min(1).max(4000),
  hashtags: nullableText,
  creativeBrief: nullableText,
  checks: nullableText
});

const createSchema = z.object({ drafts: z.array(draftSchema).min(1).max(100) });

const updateSchema = z.object({
  status: z.enum(SOCIAL_DRAFT_STATUSES as [string, ...string[]]).optional(),
  caption: z.string().trim().min(1).max(4000).optional(),
  hashtags: nullableText.optional(),
  decisionNote: nullableText.optional()
});

export async function listSocialDraftsController(req: Request, res: Response): Promise<void> {
  const rawStatus = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";
  const status = SOCIAL_DRAFT_STATUSES.includes(rawStatus as never) ? rawStatus : null;

  try {
    const rows = await listSocialDrafts({ sellerId: getSellerId(req), status: status as never, limit: getLimit(req) });
    res.json({ ok: true, sellerId: getSellerId(req), count: rows.length, rows });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not load the social drafts.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function createSocialDraftsController(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the social draft values.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return;
  }

  try {
    const rows = await createSocialDrafts(parsed.data.drafts as never);
    res.status(201).json({ ok: true, count: rows.length, rows });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not save the social drafts.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function updateSocialDraftController(req: Request, res: Response): Promise<void> {
  const parsed = updateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the social draft values.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return;
  }

  try {
    const row = await updateSocialDraft(req.params.id, parsed.data as never);
    if (!row) {
      res.status(404).json({ ok: false, message: "No social draft found with that id." });
      return;
    }
    res.json({ ok: true, row });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not update the social draft.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}
