import { Request, Response } from "express";
import { getDailyCeoReport } from "./ceo-report.service";

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getDaysFromQuery(req: Request): number {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 30;
  const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : 30;

  return Math.min(Math.max(days, 1), 30);
}

export async function getDailyCeoReportController(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const report = await getDailyCeoReport({
      sellerId,
      days: getDaysFromQuery(req)
    });

    res.json(report);
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not build CEO report from Supabase.",
      safeHint: "Check Supabase tables and service role key."
    });
  }
}
