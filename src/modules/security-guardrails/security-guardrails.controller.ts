import { Request, Response } from "express";
import { z } from "zod";
import { checkSecurityGuardrail, getSecurityGuardrailsSummary, listSecurityAuditEvents } from "./security-guardrails.service";

const checkSchema = z.object({
  sellerId: z.string().nullable().optional(),
  actor: z.string().nullable().optional(),
  action: z.string().trim().min(1),
  route: z.string().nullable().optional(),
  confirmText: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request): number {
  const raw = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 500) : 100;
}

export async function getSecurityGuardrailsSummaryRoute(req: Request, res: Response): Promise<void> {
  res.json(await getSecurityGuardrailsSummary(sellerIdFromQuery(req)));
}

export async function listSecurityAuditEventsRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  const rows = await listSecurityAuditEvents({ sellerId, limit: limitFromQuery(req) });
  res.json({ ok: true, sellerId, count: rows.length, rows });
}

export async function checkSecurityGuardrailRoute(req: Request, res: Response): Promise<void> {
  const parsed = checkSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check security guardrail input.", issues: parsed.error.issues });
    return;
  }
  res.json(await checkSecurityGuardrail(parsed.data));
}
