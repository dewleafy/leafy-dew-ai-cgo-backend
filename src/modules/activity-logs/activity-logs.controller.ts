import { Request, Response } from "express";
import { z } from "zod";
import {
  createActivityLog,
  createActivityLogEvent,
  deleteActivityLog,
  getActivityLogById,
  getActivityLogSummary,
  isActivityLogStatus,
  listActivityLogEvents,
  listActivityLogs
} from "./activity-logs.service";
import { ActivityLogSeverity, ActivityLogStatus } from "./activity-logs.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const metadataSchema = z.record(z.string(), z.unknown()).optional().default({});

const severitySchema = z.string().transform((value, context) => {
  const normalized = value.toUpperCase();
  if (!isActivityLogStatus(normalized)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "severity is not allowed."
    });
    return z.NEVER;
  }

  return normalized as ActivityLogSeverity;
});

const activityEventCreateSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  eventType: z.string().trim().min(1, "eventType is required."),
  eventCategory: z.string().trim().min(1).optional().default("SYSTEM"),
  severity: severitySchema.optional().default("INFO" as ActivityLogSeverity),
  actor: z.string().trim().min(1).optional().default("system"),
  title: z.string().trim().min(1, "title is required."),
  message: nullableTextSchema,
  entityType: nullableTextSchema,
  entityId: nullableTextSchema,
  sku: nullableTextSchema,
  asin: nullableTextSchema,
  actionId: nullableTextSchema,
  sourceModule: nullableTextSchema,
  metadata: metadataSchema
});

const legacyActivityLogCreateSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  eventType: z.string().trim().min(1, "eventType is required."),
  entityType: nullableTextSchema,
  entityId: nullableTextSchema,
  entityLabel: nullableTextSchema,
  action: z.string().trim().min(1, "action is required."),
  status: severitySchema.optional().default("INFO" as ActivityLogStatus),
  message: nullableTextSchema,
  metadata: metadataSchema,
  userNote: nullableTextSchema
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getOptionalQueryText(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getLimitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  return Math.min(Math.max(limit, 1), 500);
}

function getSeverityFromQuery(req: Request): ActivityLogSeverity | undefined {
  const severity = getOptionalQueryText(req, "severity") ?? getOptionalQueryText(req, "status");
  const normalized = severity?.toUpperCase();
  return normalized && isActivityLogStatus(normalized) ? (normalized as ActivityLogSeverity) : undefined;
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the activity log input values.",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
}

function sendDatabaseError(res: Response, message: string): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run activity_logs.sql in Supabase and check the service role key."
  });
}

export async function getActivityLogSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getActivityLogSummary(getSellerIdFromQuery(req)));
  } catch {
    sendDatabaseError(res, "Could not summarize activity logs from Supabase.");
  }
}

export async function getActivityLogEvents(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawSeverity = getOptionalQueryText(req, "severity") ?? getOptionalQueryText(req, "status");
  const severity = getSeverityFromQuery(req);

  if (rawSeverity && !severity) {
    res.status(400).json({ ok: false, message: "severity is not allowed." });
    return;
  }

  try {
    const rows = await listActivityLogEvents({
      sellerId,
      severity,
      eventType: getOptionalQueryText(req, "eventType"),
      eventCategory: getOptionalQueryText(req, "eventCategory"),
      entityType: getOptionalQueryText(req, "entityType"),
      entityId: getOptionalQueryText(req, "entityId"),
      actionId: getOptionalQueryText(req, "actionId"),
      sourceModule: getOptionalQueryText(req, "sourceModule"),
      limit: getLimitFromQuery(req)
    });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load activity logs from Supabase.");
  }
}

export async function getActivityLogs(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const rows = await listActivityLogs({
      sellerId,
      status: getSeverityFromQuery(req),
      eventType: getOptionalQueryText(req, "eventType"),
      entityType: getOptionalQueryText(req, "entityType"),
      entityId: getOptionalQueryText(req, "entityId"),
      limit: getLimitFromQuery(req)
    });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load activity logs from Supabase.");
  }
}

export async function getActivityLog(req: Request, res: Response): Promise<void> {
  try {
    const row = await getActivityLogById(req.params.id);

    if (!row) {
      res.status(404).json({ ok: false, message: "Activity log was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not load activity log from Supabase.");
  }
}

export async function postActivityLogEvent(req: Request, res: Response): Promise<void> {
  const parsed = activityEventCreateSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await createActivityLogEvent(parsed.data);
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not create activity log in Supabase.");
  }
}

export async function postActivityLog(req: Request, res: Response): Promise<void> {
  const parsed = legacyActivityLogCreateSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await createActivityLog(parsed.data);
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not create activity log in Supabase.");
  }
}

export async function deleteActivityLogById(req: Request, res: Response): Promise<void> {
  try {
    const deletedId = await deleteActivityLog(req.params.id);

    if (!deletedId) {
      res.status(404).json({ ok: false, message: "Activity log was not found." });
      return;
    }

    res.json({
      ok: true,
      deletedId
    });
  } catch {
    sendDatabaseError(res, "Could not delete activity log from Supabase.");
  }
}
