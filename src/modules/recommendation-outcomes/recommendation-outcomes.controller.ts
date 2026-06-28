import { Request, Response } from "express";
import { z } from "zod";
import {
  createRecommendationOutcomeForRecommendation,
  evaluateRecommendationOutcome,
  getRecommendationOutcomeById,
  isRecommendationOutcomeStatus,
  listRecommendationOutcomes,
  listRecommendationOutcomesByRecommendationId,
  updateRecommendationOutcome
} from "./recommendation-outcomes.service";
import { RecommendationOutcomeStatus } from "./recommendation-outcomes.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const optionalJsonObjectSchema = z.record(z.string(), z.unknown()).optional().default({});
const nullableNumberSchema = z.number().finite().optional().nullable();
const nullableIntegerSchema = z.number().int().optional().nullable();

const outcomeStatusSchema = z.string().transform((value, context) => {
  if (!isRecommendationOutcomeStatus(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "outcomeStatus is not allowed."
    });
    return z.NEVER;
  }

  return value;
});

const outcomeCreateSchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  experimentId: nullableTextSchema,
  outcomeStatus: outcomeStatusSchema.optional().default("NEEDS_MORE_DATA" as RecommendationOutcomeStatus),
  evaluationWindowDays: z.number().int().min(1).max(365).optional().default(7),
  beforeMetrics: optionalJsonObjectSchema,
  afterMetrics: optionalJsonObjectSchema,
  profitImpact: nullableNumberSchema,
  salesImpact: nullableNumberSchema,
  costImpact: nullableNumberSchema,
  acosBefore: nullableNumberSchema,
  acosAfter: nullableNumberSchema,
  ordersBefore: nullableIntegerSchema,
  ordersAfter: nullableIntegerSchema,
  confidenceAfter: nullableNumberSchema,
  resultSummary: nullableTextSchema,
  learningNote: nullableTextSchema
});

const outcomeUpdateSchema = outcomeCreateSchema.partial();

const evaluateSchema = z.object({
  outcomeStatus: outcomeStatusSchema,
  afterMetrics: optionalJsonObjectSchema,
  resultSummary: nullableTextSchema,
  learningNote: nullableTextSchema
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

function getStatusFromQuery(req: Request): RecommendationOutcomeStatus | undefined {
  const status = getOptionalQueryText(req, "status");
  return status && isRecommendationOutcomeStatus(status) ? status : undefined;
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the recommendation outcome input values.",
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
    safeHint: "Run recommendation_outcomes.sql in Supabase and check the service role key."
  });
}

export async function getRecommendationOutcomes(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawStatus = getOptionalQueryText(req, "status");
  const status = getStatusFromQuery(req);

  if (rawStatus && !status) {
    res.status(400).json({ ok: false, message: "status is not allowed." });
    return;
  }

  try {
    const rows = await listRecommendationOutcomes({
      sellerId,
      status,
      recommendationId: getOptionalQueryText(req, "recommendationId"),
      experimentId: getOptionalQueryText(req, "experimentId")
    });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load recommendation outcomes from Supabase.");
  }
}

export async function getRecommendationOutcome(req: Request, res: Response): Promise<void> {
  try {
    const row = await getRecommendationOutcomeById(req.params.id);

    if (!row) {
      res.status(404).json({ ok: false, message: "Recommendation outcome was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not load recommendation outcome from Supabase.");
  }
}

export async function getOutcomesForRecommendation(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listRecommendationOutcomesByRecommendationId(req.params.id);

    res.json({
      ok: true,
      recommendationId: req.params.id,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load recommendation outcomes from Supabase.");
  }
}

export async function postOutcomeForRecommendation(req: Request, res: Response): Promise<void> {
  const parsed = outcomeCreateSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await createRecommendationOutcomeForRecommendation({
      recommendationId: req.params.id,
      outcome: parsed.data
    });

    if (!row) {
      res.status(404).json({ ok: false, message: "Recommendation was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not create recommendation outcome in Supabase.");
  }
}

export async function putRecommendationOutcome(req: Request, res: Response): Promise<void> {
  const parsed = outcomeUpdateSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await updateRecommendationOutcome({
      id: req.params.id,
      updates: parsed.data
    });

    if (!row) {
      res.status(404).json({ ok: false, message: "Recommendation outcome was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not update recommendation outcome in Supabase.");
  }
}

export async function postEvaluateRecommendationOutcome(req: Request, res: Response): Promise<void> {
  const parsed = evaluateSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await evaluateRecommendationOutcome({
      id: req.params.id,
      evaluation: parsed.data
    });

    if (!row) {
      res.status(404).json({ ok: false, message: "Recommendation outcome was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not evaluate recommendation outcome in Supabase.");
  }
}
