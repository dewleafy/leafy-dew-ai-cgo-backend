import { Request, Response } from "express";
import { getMaintenanceSummary, listMaintenanceRuns, runMaintenance } from "./maintenance.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 50): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : fallback;
  return Math.min(Math.max(limit, 1), 100);
}

function sendMaintenanceError(res: Response): void {
  res.status(503).json({
    ok: false,
    message: "Could not use Maintenance Runner. Run maintenance_runs.sql and check service role access."
  });
}

export async function runMaintenanceRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await runMaintenance({ sellerId: sellerIdFromQuery(req), runType: "MANUAL" }));
  } catch {
    sendMaintenanceError(res);
  }
}

export async function listMaintenanceRunsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listMaintenanceRuns({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendMaintenanceError(res);
  }
}

export async function getMaintenanceSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getMaintenanceSummary(sellerIdFromQuery(req)));
  } catch {
    sendMaintenanceError(res);
  }
}
