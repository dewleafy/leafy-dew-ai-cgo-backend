import { Request, Response } from "express";
import { z } from "zod";
import {
  estimateAiUsage,
  generateAiResponse,
  getAiCostSummary,
  getAiGatewayStatus,
  listAiCostLedger,
  recordBlockedAiAttempt,
  updateAiGatewaySettings
} from "./ai-gateway.service";

const aiEstimateSchema = z.object({
  sellerId: z.string().trim().min(1).optional(),
  moduleName: z.string().trim().min(1),
  purpose: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  inputTokens: z.number().finite().optional(),
  outputTokens: z.number().finite().optional(),
  provider: z.string().nullable().optional(),
  modelName: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const blockedSchema = aiEstimateSchema.extend({
  requestId: z.string().nullable().optional(),
  blockedReason: z.string().nullable().optional()
});

const generateSchema = aiEstimateSchema.extend({
  requestId: z.string().nullable().optional(),
  maxOutputTokens: z.number().finite().optional(),
  actor: z.string().nullable().optional()
});

const updateSettingsSchema = z.object({
  sellerId: z.string().trim().min(1).optional(),
  aiCallsEnabled: z.boolean().optional(),
  dailyBudget: z.number().finite().nonnegative().optional(),
  monthlyBudget: z.number().finite().nonnegative().optional(),
  allowedModules: z.array(z.string()).optional(),
  blockedModules: z.array(z.string()).optional(),
  defaultProvider: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional()
});

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  return Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : fallback;
}

function sendAiGatewayError(res: Response, message = "Could not use AI Gateway."): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run ai_gateway_cost_ledger.sql in Supabase and check service role access."
  });
}

export async function getAiGatewayStatusRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getAiGatewayStatus(sellerIdFromQuery(req)));
  } catch {
    sendAiGatewayError(res);
  }
}

export async function getAiCostSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getAiCostSummary(sellerIdFromQuery(req)));
  } catch {
    sendAiGatewayError(res, "Could not summarize AI Gateway costs.");
  }
}

export async function listAiCostLedgerRoute(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromQuery(req);
  try {
    const rows = await listAiCostLedger({ sellerId, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendAiGatewayError(res, "Could not load AI Gateway ledger.");
  }
}

export async function estimateAiUsageRoute(req: Request, res: Response): Promise<void> {
  const parsed = aiEstimateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check AI estimate input.", issues: parsed.error.issues });
    return;
  }

  res.json(estimateAiUsage(parsed.data));
}

export async function recordBlockedAiAttemptRoute(req: Request, res: Response): Promise<void> {
  const parsed = blockedSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check blocked AI attempt input.", issues: parsed.error.issues });
    return;
  }

  try {
    const row = await recordBlockedAiAttempt(parsed.data);
    res.json({ ok: true, row, aiCallsEnabled: false, message: "AI call attempt recorded as blocked. No AI provider was called." });
  } catch {
    sendAiGatewayError(res, "Could not record blocked AI attempt.");
  }
}

export async function generateAiResponseRoute(req: Request, res: Response): Promise<void> {
  const parsed = generateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check AI generate input.", issues: parsed.error.issues });
    return;
  }

  try {
    res.json(await generateAiResponse(parsed.data));
  } catch {
    sendAiGatewayError(res, "Could not process AI generate request.");
  }
}

export async function updateAiGatewaySettingsRoute(req: Request, res: Response): Promise<void> {
  const parsed = updateSettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Please check AI Gateway settings input.", issues: parsed.error.issues });
    return;
  }

  const { sellerId, ...patch } = parsed.data;
  try {
    const settings = await updateAiGatewaySettings(sellerId ?? sellerIdFromQuery(req), patch);
    res.json({ ok: true, settings, message: "AI Gateway settings updated." });
  } catch {
    sendAiGatewayError(res, "Could not update AI Gateway settings.");
  }
}
