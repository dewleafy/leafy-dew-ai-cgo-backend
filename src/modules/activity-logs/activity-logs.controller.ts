import { Request, Response } from "express";
import { z } from "zod";
import {
  createActivityLog,
  deleteActivityLog,
  getActivityLogById,
  isActivityLogStatus,
  listActivityLogs
} from "./activity-logs.service";
import { ActivityLogStatus } from "./activity-logs.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const metadataSchema = z.record(z.string(), z.unknown()).optional().default({});

const statusSchema = z.string().transform((value, context) => {
  if (!isActivityLogStatus(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status is not allowed."
    });
    return z.NEVER;
  }

  return value;
});

const activityLogCreateSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  eventType: z.string().trim().min(1, "eventType is required."),
  entityType: nullableTextSchema,
  entityId: nullableTextSchema,
  entityLabel: nullableTextSchema,
  action: z.string().trim().min(1, "action is required."),
  status: statusSchema.optional().default("INFO" as ActivityLogStatus),
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
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50;
  return Math.min(Math.max(limit, 1), 200);
}

function getStatusFromQuery(req: Request): ActivityLogStatus | undefined {
  const status = getOptionalQueryText(req, "status");
  return status && isActivityLogStatus(status) ? status : undefined;
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

export async function getActivityLogs(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawStatus = getOptionalQueryText(req, "status");
  const status = getStatusFromQuery(req);

  if (rawStatus && !status) {
    res.status(400).json({ ok: false, message: "status is not allowed." });
    return;
  }

  try {
    const rows = await listActivityLogs({
      sellerId,
      status,
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

export async function postActivityLog(req: Request, res: Response): Promise<void> {
  const parsed = activityLogCreateSchema.safeParse(req.body ?? {});

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
