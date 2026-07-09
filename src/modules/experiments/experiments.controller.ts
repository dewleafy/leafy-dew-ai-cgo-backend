import { Request, Response } from "express";
import { z } from "zod";
import {
  cancelExperiment,
  completeExperiment,
  createExperiment,
  createExperimentFromAction,
  getExperimentById,
  getExperimentSummary,
  isExperimentPriority,
  isExperimentResultStatus,
  isExperimentStatus,
  isExperimentType,
  listExperimentEvents,
  listExperiments,
  recordExperimentCheckpoint,
  startExperiment,
  updateExperiment
} from "./experiments.service";
import { ExperimentPriority, ExperimentResultStatus, ExperimentStatus, ExperimentType } from "./experiments.types";

const nullableTextSchema = z.string().optional().nullable().transform((value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
});
const optionalJsonObjectSchema = z.record(z.string(), z.unknown()).optional().default({});

function enumSchema<T extends string>(isAllowed: (value: string) => value is T, message: string) {
  return z.string().transform((value, context) => {
    if (!isAllowed(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    }
    return value;
  });
}

const experimentTypeSchema = enumSchema<ExperimentType>(isExperimentType, "experimentType is not allowed.");
const statusSchema = enumSchema<ExperimentStatus>(isExperimentStatus, "status is not allowed.");
const prioritySchema = enumSchema<ExperimentPriority>(isExperimentPriority, "priority is not allowed.");
const resultStatusSchema = enumSchema<ExperimentResultStatus>(isExperimentResultStatus, "resultStatus is not allowed.");

const experimentBaseSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  experimentKey: nullableTextSchema,
  name: z.string().trim().min(1).optional(),
  experimentName: z.string().trim().min(1).optional(),
  description: nullableTextSchema,
  experimentType: experimentTypeSchema,
  status: statusSchema.optional().default("DRAFT" as ExperimentStatus),
  actionId: nullableTextSchema,
  engineKey: nullableTextSchema,
  sku: nullableTextSchema,
  asin: nullableTextSchema,
  hypothesis: nullableTextSchema,
  baselineMetrics: optionalJsonObjectSchema,
  targetMetrics: optionalJsonObjectSchema,
  currentMetrics: optionalJsonObjectSchema,
  resultSummary: nullableTextSchema,
  resultStatus: resultStatusSchema.nullable().optional(),
  startedAt: nullableTextSchema,
  endedAt: nullableTextSchema,
  productPassportId: nullableTextSchema,
  campaignId: nullableTextSchema,
  adGroupId: nullableTextSchema,
  recommendationId: nullableTextSchema,
  expectedResult: nullableTextSchema,
  successMetric: nullableTextSchema,
  beforeMetrics: optionalJsonObjectSchema,
  afterMetrics: optionalJsonObjectSchema,
  learningNote: nullableTextSchema,
  priority: prioritySchema.optional().default("MEDIUM" as ExperimentPriority),
  startDate: nullableTextSchema,
  endDate: nullableTextSchema
});

const experimentCreateSchema = experimentBaseSchema.refine((value) => Boolean(value.name || value.experimentName), {
  message: "name or experimentName is required.",
  path: ["name"]
});

const experimentUpdateSchema = experimentBaseSchema.partial();
const checkpointBodySchema = z.object({
  actor: z.string().trim().min(1).optional(),
  note: nullableTextSchema,
  currentMetrics: optionalJsonObjectSchema,
  metadata: optionalJsonObjectSchema
});
const completeBodySchema = z.object({
  resultStatus: resultStatusSchema.default("INCONCLUSIVE" as ExperimentResultStatus),
  resultSummary: nullableTextSchema,
  learningNote: nullableTextSchema,
  currentMetrics: optionalJsonObjectSchema,
  actor: z.string().trim().min(1).optional()
});
const cancelBodySchema = z.object({
  learningNote: nullableTextSchema,
  actor: z.string().trim().min(1).optional()
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

function limitFromQuery(req: Request, fallback = 100): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  return Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : fallback;
}

function getStatusFromQuery(req: Request): ExperimentStatus | undefined {
  return typeof req.query.status === "string" && isExperimentStatus(req.query.status) ? req.query.status : undefined;
}

function getExperimentTypeFromQuery(req: Request): ExperimentType | undefined {
  return typeof req.query.type === "string" && isExperimentType(req.query.type) ? req.query.type : undefined;
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({ ok: false, message: "Please check the experiment input values.", issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
}

function sendDatabaseError(res: Response, message: string): void {
  res.status(503).json({ ok: false, message, safeHint: "Run experiment_tracking.sql in Supabase and check service role access." });
}

export async function getExperimentsSummary(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getExperimentSummary(getSellerIdFromQuery(req)));
  } catch {
    sendDatabaseError(res, "Could not summarize experiments from Supabase.");
  }
}

export async function getExperiments(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawStatus = typeof req.query.status === "string" && req.query.status.trim() ? req.query.status : undefined;
  const rawType = typeof req.query.type === "string" && req.query.type.trim() ? req.query.type : undefined;
  const status = getStatusFromQuery(req);
  const experimentType = getExperimentTypeFromQuery(req);

  if (rawStatus && !status) {
    res.status(400).json({ ok: false, message: "status is not allowed." });
    return;
  }
  if (rawType && !experimentType) {
    res.status(400).json({ ok: false, message: "type is not allowed." });
    return;
  }

  try {
    const rows = await listExperiments({ sellerId, status, experimentType, limit: limitFromQuery(req) });
    res.json({ ok: true, sellerId, count: rows.length, rows });
  } catch {
    sendDatabaseError(res, "Could not load experiments from Supabase.");
  }
}

export async function getExperiment(req: Request, res: Response): Promise<void> {
  try {
    const row = await getExperimentById(req.params.id, getSellerIdFromQuery(req));
    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }
    const events = await listExperimentEvents(row.id).catch(() => []);
    res.json({ ok: true, row, events });
  } catch {
    sendDatabaseError(res, "Could not load experiment from Supabase.");
  }
}

export async function postExperiment(req: Request, res: Response): Promise<void> {
  const parsed = experimentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await createExperiment(parsed.data);
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not create experiment in Supabase.");
  }
}

export async function postExperimentFromAction(req: Request, res: Response): Promise<void> {
  try {
    const row = await createExperimentFromAction(req.params.actionId);
    res.json({ ok: true, row });
  } catch (error) {
    if (error instanceof Error && error.message === "ACTION_NOT_FOUND") {
      res.status(404).json({ ok: false, message: "Action ledger row was not found." });
      return;
    }
    if (error instanceof Error && error.message === "ACTION_NOT_APPROVED") {
      res.status(400).json({ ok: false, message: "Experiment can be created from approved or monitoring actions only." });
      return;
    }
    sendDatabaseError(res, "Could not create experiment from action.");
  }
}

export async function putExperiment(req: Request, res: Response): Promise<void> {
  const parsed = experimentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await updateExperiment({ id: req.params.id, updates: parsed.data });
    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not update experiment in Supabase.");
  }
}

export async function postStartExperiment(req: Request, res: Response): Promise<void> {
  try {
    const row = await startExperiment(req.params.id, "founder");
    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not start experiment in Supabase.");
  }
}

export async function postRecordCheckpoint(req: Request, res: Response): Promise<void> {
  const parsed = checkpointBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await recordExperimentCheckpoint({ id: req.params.id, ...parsed.data });
    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not record experiment checkpoint.");
  }
}

export async function postCompleteExperiment(req: Request, res: Response): Promise<void> {
  const parsed = completeBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await completeExperiment({ id: req.params.id, ...parsed.data });
    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not complete experiment in Supabase.");
  }
}

export async function postCancelExperiment(req: Request, res: Response): Promise<void> {
  const parsed = cancelBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await cancelExperiment({ id: req.params.id, ...parsed.data });
    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not cancel experiment in Supabase.");
  }
}

export const deleteExperiment = postCancelExperiment;
