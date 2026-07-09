import { Request, Response } from "express";
import { z } from "zod";
import {
  checkDataFreshness,
  getDataFreshnessSummary,
  isDataFreshnessSource,
  isDataFreshnessStatus,
  markDataFreshness
} from "./data-freshness.service";
import { DataFreshnessSource, DataFreshnessStatusValue } from "./data-freshness.types";

function enumSchema<T extends string>(isAllowed: (value: string) => value is T, message: string) {
  return z.string().transform((value, context) => {
    if (!isAllowed(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    }
    return value;
  });
}

const markSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  dataSource: enumSchema<DataFreshnessSource>(isDataFreshnessSource, "dataSource is not allowed."),
  status: enumSchema<DataFreshnessStatusValue>(isDataFreshnessStatus, "status is not allowed."),
  lastSuccessAt: z.string().nullable().optional(),
  lastAttemptAt: z.string().nullable().optional(),
  staleAfterMinutes: z.number().finite().optional(),
  lastError: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function sendDataFreshnessError(res: Response, message = "Could not use Data Freshness."): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run data_freshness.sql in Supabase and check service role access."
  });
}

export async function getDataFreshnessSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getDataFreshnessSummary(sellerIdFromQuery(req)));
  } catch {
    sendDataFreshnessError(res);
  }
}

export async function checkDataFreshnessRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await checkDataFreshness(sellerIdFromQuery(req)));
  } catch {
    sendDataFreshnessError(res, "Could not check data freshness.");
  }
}

export async function markDataFreshnessRoute(req: Request, res: Response): Promise<void> {
  const parsed = markSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check data freshness input.", issues: parsed.error.issues });
    return;
  }

  try {
    const row = await markDataFreshness(parsed.data);
    res.json({ ok: true, row });
  } catch {
    sendDataFreshnessError(res, "Could not mark data freshness.");
  }
}
