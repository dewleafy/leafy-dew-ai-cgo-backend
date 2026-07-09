import { Request, Response } from "express";
import {
  generateAlerts,
  getAlertSummary,
  listAlertEvents,
  seedDefaultAlertRules,
  updateAlertEventStatus
} from "./alert-center.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  return Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : fallback;
}

function sendAlertDatabaseError(res: Response, message = "Could not use Alert Center."): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run alert_center.sql in Supabase and check service role access."
  });
}

export async function getAlertSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getAlertSummary(sellerIdFromQuery(req)));
  } catch {
    sendAlertDatabaseError(res);
  }
}

export async function listAlertEventsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listAlertEvents({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendAlertDatabaseError(res);
  }
}

export async function generateAlertsRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await generateAlerts(sellerIdFromQuery(req)));
  } catch {
    sendAlertDatabaseError(res, "Could not generate internal alerts.");
  }
}

export async function seedAlertRulesRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, ...(await seedDefaultAlertRules(sellerIdFromQuery(req))) });
  } catch {
    sendAlertDatabaseError(res, "Could not seed alert rules.");
  }
}

export async function acknowledgeAlertEventRoute(req: Request, res: Response): Promise<void> {
  try {
    const row = await updateAlertEventStatus({ id: req.params.id, status: "ACKNOWLEDGED" });
    if (!row) {
      res.status(404).json({ ok: false, message: "Alert event was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendAlertDatabaseError(res, "Could not acknowledge alert event.");
  }
}

export async function resolveAlertEventRoute(req: Request, res: Response): Promise<void> {
  try {
    const row = await updateAlertEventStatus({ id: req.params.id, status: "RESOLVED" });
    if (!row) {
      res.status(404).json({ ok: false, message: "Alert event was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendAlertDatabaseError(res, "Could not resolve alert event.");
  }
}
