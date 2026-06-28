import { Request, Response } from "express";
import { z } from "zod";
import {
  cancelExperiment,
  completeExperiment,
  createExperiment,
  getExperimentById,
  isExperimentPriority,
  isExperimentStatus,
  isExperimentType,
  listExperiments,
  startExperiment,
  updateExperiment
} from "./experiments.service";
import { ExperimentPriority, ExperimentStatus, ExperimentType } from "./experiments.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const optionalJsonObjectSchema = z.record(z.string(), z.unknown()).optional().default({});

function enumSchema<T extends string>(
  isAllowed: (value: string) => value is T,
  message: string
) {
  return z.string().transform((value, context) => {
    if (!isAllowed(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message
      });
      return z.NEVER;
    }

    return value;
  });
}

const experimentTypeSchema = enumSchema<ExperimentType>(
  isExperimentType,
  "experimentType is not allowed."
);
const statusSchema = enumSchema<ExperimentStatus>(
  isExperimentStatus,
  "status is not allowed."
);
const prioritySchema = enumSchema<ExperimentPriority>(
  isExperimentPriority,
  "priority is not allowed."
);

const experimentCreateSchema = z.object({
  sellerId: z.string().trim().min(1).default("default"),
  experimentName: z.string().trim().min(1, "experimentName is required."),
  experimentType: experimentTypeSchema,
  productPassportId: nullableTextSchema,
  sku: nullableTextSchema,
  asin: nullableTextSchema,
  campaignId: nullableTextSchema,
  adGroupId: nullableTextSchema,
  recommendationId: nullableTextSchema,
  hypothesis: nullableTextSchema,
  expectedResult: nullableTextSchema,
  successMetric: nullableTextSchema,
  beforeMetrics: optionalJsonObjectSchema,
  afterMetrics: optionalJsonObjectSchema,
  resultSummary: nullableTextSchema,
  learningNote: nullableTextSchema,
  status: statusSchema.optional().default("PLANNED" as ExperimentStatus),
  priority: prioritySchema.optional().default("MEDIUM" as ExperimentPriority),
  startDate: nullableTextSchema,
  endDate: nullableTextSchema
});

const experimentUpdateSchema = experimentCreateSchema.partial().extend({
  experimentName: z.string().trim().min(1, "experimentName cannot be empty.").optional()
});

const completeBodySchema = z.object({
  resultSummary: nullableTextSchema,
  learningNote: nullableTextSchema,
  afterMetrics: optionalJsonObjectSchema.optional()
});

const cancelBodySchema = z.object({
  learningNote: nullableTextSchema
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getStatusFromQuery(req: Request): ExperimentStatus | undefined {
  if (typeof req.query.status !== "string" || !req.query.status.trim()) {
    return undefined;
  }

  return isExperimentStatus(req.query.status) ? req.query.status : undefined;
}

function getExperimentTypeFromQuery(req: Request): ExperimentType | undefined {
  if (typeof req.query.type !== "string" || !req.query.type.trim()) {
    return undefined;
  }

  return isExperimentType(req.query.type) ? req.query.type : undefined;
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the experiment input values.",
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
    safeHint: "Run experiments.sql in Supabase and check the service role key."
  });
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
    const rows = await listExperiments({ sellerId, status, experimentType });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load experiments from Supabase.");
  }
}

export async function getExperiment(req: Request, res: Response): Promise<void> {
  try {
    const row = await getExperimentById(req.params.id);

    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }

    res.json({ ok: true, row });
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
    const row = await startExperiment(req.params.id);

    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not start experiment in Supabase.");
  }
}

export async function postCompleteExperiment(req: Request, res: Response): Promise<void> {
  const parsed = completeBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await completeExperiment({
      id: req.params.id,
      resultSummary: parsed.data.resultSummary,
      learningNote: parsed.data.learningNote,
      afterMetrics: parsed.data.afterMetrics
    });

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
    const row = await cancelExperiment({
      id: req.params.id,
      learningNote: parsed.data.learningNote
    });

    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not cancel experiment in Supabase.");
  }
}

export async function deleteExperiment(req: Request, res: Response): Promise<void> {
  try {
    const row = await cancelExperiment({ id: req.params.id });

    if (!row) {
      res.status(404).json({ ok: false, message: "Experiment was not found." });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not cancel experiment in Supabase.");
  }
}
