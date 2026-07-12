import { Request, Response } from "express";
import { z } from "zod";
import {
  getNotificationOutboxSummary,
  getNotificationSettings,
  initializeNotificationSettings,
  listNotificationMessages,
  queueNotification,
  sendNotification
} from "./notification-outbox.service";

const queueSchema = z.object({
  sellerId: z.string().nullable().optional(),
  channel: z.string().trim().min(1),
  recipient: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  message: z.string().trim().min(1),
  sourceModule: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request): number {
  const raw = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 500) : 100;
}

export async function getNotificationOutboxSummaryRoute(req: Request, res: Response): Promise<void> {
  res.json(await getNotificationOutboxSummary(sellerIdFromQuery(req)));
}

export async function listNotificationMessagesRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const rows = await listNotificationMessages({ sellerId, limit: limitFromQuery(req) });
  res.json({ ok: true, sellerId, count: rows.length, rows });
}

export async function getNotificationSettingsRoute(req: Request, res: Response): Promise<void> {
  res.json({ ok: true, settings: await getNotificationSettings(sellerIdFromQuery(req)) });
}

export async function initializeNotificationSettingsRoute(req: Request, res: Response): Promise<void> {
  res.json({ ok: true, settings: await initializeNotificationSettings(sellerIdFromQuery(req)) });
}

export async function queueNotificationRoute(req: Request, res: Response): Promise<void> {
  const parsed = queueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check notification queue input.", issues: parsed.error.issues });
    return;
  }
  const row = await queueNotification(parsed.data);
  res.json({ ok: true, row, message: "Notification queued internally. No external send attempted." });
}

export async function sendNotificationRoute(req: Request, res: Response): Promise<void> {
  res.json(await sendNotification({
    id: req.params.id,
    actor: typeof req.body?.actor === "string" ? req.body.actor : "founder"
  }));
}
