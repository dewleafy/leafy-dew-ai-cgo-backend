import { Request, Response } from "express";
import { z } from "zod";
import {
  SOCIAL_CONTENT_PLATFORMS,
  SOCIAL_CONTENT_STATUSES,
  createSocialContentLogEntry,
  deleteSocialContentLogEntry,
  listSocialContentLog,
  updateSocialContentLogEntry
} from "./social-content-log.service";

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

const nullableTrimmedString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .nullable()
  .transform((value) => value ?? null);

const dateStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional()
  .nullable()
  .transform((value) => value ?? null);

const createSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  platform: z.enum(SOCIAL_CONTENT_PLATFORMS as [string, ...string[]]),
  contentType: nullableTrimmedString,
  title: nullableTrimmedString,
  sku: nullableTrimmedString,
  asin: nullableTrimmedString,
  status: z.enum(SOCIAL_CONTENT_STATUSES as [string, ...string[]]).optional().default("PLANNED"),
  plannedDate: dateStringSchema,
  postedDate: dateStringSchema,
  notes: nullableTrimmedString
});

const updateSchema = createSchema.partial().omit({ sellerId: true });

export async function listSocialContentLogController(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listSocialContentLog({ sellerId: getSellerId(req), limit: getLimit(req) });
    res.json({ ok: true, sellerId: getSellerId(req), count: rows.length, rows });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not load the social content log.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function createSocialContentLogController(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the social content log entry values.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return;
  }

  try {
    const row = await createSocialContentLogEntry({
      sellerId: parsed.data.sellerId,
      platform: parsed.data.platform as never,
      contentType: parsed.data.contentType,
      title: parsed.data.title,
      sku: parsed.data.sku,
      asin: parsed.data.asin,
      status: parsed.data.status as never,
      plannedDate: parsed.data.plannedDate,
      postedDate: parsed.data.postedDate,
      notes: parsed.data.notes
    });
    res.status(201).json({ ok: true, row });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not save the social content log entry.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function updateSocialContentLogController(req: Request, res: Response): Promise<void> {
  const parsed = updateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the social content log entry values.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return;
  }

  try {
    const row = await updateSocialContentLogEntry(req.params.id, parsed.data as never);
    if (!row) {
      res.status(404).json({ ok: false, message: "No social content log entry found with that id." });
      return;
    }
    res.json({ ok: true, row });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not update the social content log entry.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}

export async function deleteSocialContentLogController(req: Request, res: Response): Promise<void> {
  try {
    const deleted = await deleteSocialContentLogEntry(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, message: "No social content log entry found with that id." });
      return;
    }
    res.json({ ok: true, id: req.params.id });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: "Could not delete the social content log entry.",
      error: error instanceof Error ? error.message : undefined
    });
  }
}
