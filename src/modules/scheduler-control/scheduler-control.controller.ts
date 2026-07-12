import { Request, Response } from "express";
import { z } from "zod";
import {
  getSchedulerControlSummary,
  listSchedulerJobs,
  runSchedulerJob,
  seedSchedulerJobs,
  updateSchedulerJob
} from "./scheduler-control.service";

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  scheduleHint: z.string().nullable().optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function getSchedulerControlSummaryRoute(req: Request, res: Response): Promise<void> {
  res.json(await getSchedulerControlSummary(sellerIdFromQuery(req)));
}

export async function listSchedulerJobsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const rows = await listSchedulerJobs(sellerId);
  res.json({ ok: true, sellerId, count: rows.length, rows });
}

export async function seedSchedulerJobsRoute(req: Request, res: Response): Promise<void> {
  res.json(await seedSchedulerJobs(sellerIdFromQuery(req)));
}

export async function runSchedulerJobRoute(req: Request, res: Response): Promise<void> {
  res.json(await runSchedulerJob({ sellerId: sellerIdFromQuery(req), jobKey: req.params.jobKey }));
}

export async function updateSchedulerJobRoute(req: Request, res: Response): Promise<void> {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check scheduler job input.", issues: parsed.error.issues });
    return;
  }
  const row = await updateSchedulerJob({ sellerId: sellerIdFromQuery(req), jobKey: req.params.jobKey, ...parsed.data });
  res.json({ ok: Boolean(row), row });
}
