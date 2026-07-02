import { Request, Response } from "express";
import { z } from "zod";
import {
  createActionLedgerRow,
  getActionLedgerById,
  getActionLedgerSummary,
  isActionLedgerActionType,
  isActionLedgerApprovalStatus,
  isActionLedgerApprovalTier,
  isActionLedgerConfidenceLabel,
  isActionLedgerEntityType,
  isActionLedgerRiskLevel,
  isActionLedgerSource,
  isActionLedgerState,
  listActionLedgerRows,
  updateActionLedgerApprovalState
} from "./action-ledger.service";
import {
  ActionLedgerActionType,
  ActionLedgerApprovalStatus,
  ActionLedgerApprovalTier,
  ActionLedgerConfidenceLabel,
  ActionLedgerEntityType,
  ActionLedgerRiskLevel,
  ActionLedgerSource,
  ActionLedgerState
} from "./action-ledger.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .default({});

const nullableJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .nullable()
  .default(null);

function enumSchema<T extends string>(
  label: string,
  guard: (value: string) => value is T
): z.ZodEffects<z.ZodString, T, string> {
  return z.string().trim().transform((value, context) => {
    const normalized = value.toUpperCase();

    if (!guard(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} is not allowed.`
      });
      return z.NEVER;
    }

    return normalized;
  });
}

const sourceSchema = enumSchema<ActionLedgerSource>("source", isActionLedgerSource);
const actionTypeSchema = enumSchema<ActionLedgerActionType>("actionType", isActionLedgerActionType);
const entityTypeSchema = enumSchema<ActionLedgerEntityType>("entityType", isActionLedgerEntityType);
const riskLevelSchema = enumSchema<ActionLedgerRiskLevel>("riskLevel", isActionLedgerRiskLevel);
const confidenceLabelSchema = enumSchema<ActionLedgerConfidenceLabel>("confidenceLabel", isActionLedgerConfidenceLabel);
const approvalTierSchema = enumSchema<ActionLedgerApprovalTier>("approvalTier", isActionLedgerApprovalTier);
const stateSchema = enumSchema<ActionLedgerState>("state", isActionLedgerState);
const approvalStatusSchema = enumSchema<ActionLedgerApprovalStatus>("approvalStatus", isActionLedgerApprovalStatus);

const actionLedgerCreateSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  source: sourceSchema,
  sourceId: nullableTextSchema,
  actionType: actionTypeSchema,
  entityType: entityTypeSchema.optional().nullable(),
  entityId: nullableTextSchema,
  sku: nullableTextSchema,
  asin: nullableTextSchema,
  title: z.string().trim().min(1, "title is required."),
  summary: nullableTextSchema,
  recommendedAction: nullableTextSchema,
  expectedProfitImpact: z.coerce.number().finite().optional().nullable(),
  expectedSalesImpact: z.coerce.number().finite().optional().nullable(),
  expectedBrandImpact: z.coerce.number().finite().optional().nullable(),
  riskLevel: riskLevelSchema.optional().default("MEDIUM" as ActionLedgerRiskLevel),
  confidenceLabel: confidenceLabelSchema.optional().default("MEDIUM" as ActionLedgerConfidenceLabel),
  approvalTier: approvalTierSchema.optional().default("TIER_2" as ActionLedgerApprovalTier),
  requiresApproval: z.boolean().optional().default(true),
  state: stateSchema.optional(),
  approvalStatus: approvalStatusSchema.optional(),
  payload: jsonObjectSchema,
  evidence: jsonObjectSchema,
  guardrails: jsonObjectSchema,
  rollbackSnapshot: nullableJsonObjectSchema
});

const noteSchema = z.object({
  note: nullableTextSchema,
  approvedBy: nullableTextSchema
});

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeActionLedgerId(id: unknown): string {
  return String(id || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");
}

function getValidActionLedgerId(req: Request, res: Response): string | null {
  const rawId = req.params.id || req.params.actionId || req.params.actionLedgerId || "";
  const cleanId = normalizeActionLedgerId(rawId);

  if (!uuidRegex.test(cleanId)) {
    res.status(400).json({
      ok: false,
      message: "Invalid action ledger id.",
      receivedParamKeys: Object.keys(req.params || {})
    });
    return null;
  }

  return cleanId;
}

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getOptionalQueryText(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getLimitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50;
  return Math.min(Math.max(limit, 1), 200);
}

function normalizeQueryEnum<T extends string>(
  value: string | undefined,
  guard: (input: string) => input is T
): T | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  return guard(normalized) ? normalized : undefined;
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the action ledger input values.",
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
    safeHint: "Run action_ledger.sql in Supabase and check the service role key."
  });
}

export async function getActionLedgerRows(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const rawStatus = getOptionalQueryText(req, "approvalStatus") ?? getOptionalQueryText(req, "status");
  const rawState = getOptionalQueryText(req, "state");
  const rawActionType = getOptionalQueryText(req, "actionType");
  const approvalStatus = normalizeQueryEnum(rawStatus, isActionLedgerApprovalStatus);
  const state = normalizeQueryEnum(rawState, isActionLedgerState);
  const actionType = normalizeQueryEnum(rawActionType, isActionLedgerActionType);

  if ((rawStatus && !approvalStatus) || (rawState && !state) || (rawActionType && !actionType)) {
    res.status(400).json({ ok: false, message: "One or more action ledger filters are not allowed." });
    return;
  }

  try {
    const rows = await listActionLedgerRows({
      sellerId,
      approvalStatus,
      state,
      actionType,
      sku: getOptionalQueryText(req, "sku"),
      asin: getOptionalQueryText(req, "asin"),
      limit: getLimitFromQuery(req)
    });

    res.json({
      ok: true,
      sellerId,
      count: rows.length,
      rows
    });
  } catch {
    sendDatabaseError(res, "Could not load action ledger from Supabase.");
  }
}

export async function getActionLedgerSummaryRoute(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const summary = await getActionLedgerSummary(sellerId);

    res.json({
      ok: true,
      sellerId,
      ...summary
    });
  } catch {
    sendDatabaseError(res, "Could not summarize action ledger from Supabase.");
  }
}

export async function getActionLedgerRow(req: Request, res: Response): Promise<void> {
  const cleanId = getValidActionLedgerId(req, res);
  if (!cleanId) return;

  try {
    const row = await getActionLedgerById(cleanId);

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Action ledger row not found.",
        idUsed: cleanId
      });
      return;
    }

    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not load action ledger row from Supabase.");
  }
}

export async function postActionLedgerRow(req: Request, res: Response): Promise<void> {
  const parsed = actionLedgerCreateSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await createActionLedgerRow(parsed.data);
    res.json({ ok: true, row });
  } catch {
    sendDatabaseError(res, "Could not create action ledger row in Supabase.");
  }
}

async function updateState(
  req: Request,
  res: Response,
  approvalStatus: ActionLedgerApprovalStatus,
  state: ActionLedgerState,
  message: string
): Promise<void> {
  const cleanId = getValidActionLedgerId(req, res);
  if (!cleanId) return;

  const parsed = noteSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const row = await updateActionLedgerApprovalState({
      id: cleanId,
      approvalStatus,
      state,
      note: parsed.data.note,
      approvedBy: parsed.data.approvedBy
    });

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Action ledger row not found.",
        idUsed: cleanId
      });
      return;
    }

    res.json({
      ok: true,
      message,
      row
    });
  } catch {
    sendDatabaseError(res, "Could not update action ledger row in Supabase.");
  }
}

export async function approveActionLedgerRow(req: Request, res: Response): Promise<void> {
  await updateState(req, res, "APPROVED", "APPROVED", "Action approved in shadow mode. No external action was executed.");
}

export async function rejectActionLedgerRow(req: Request, res: Response): Promise<void> {
  await updateState(req, res, "REJECTED", "REJECTED", "Action rejected. No external action was executed.");
}

export async function monitorActionLedgerRow(req: Request, res: Response): Promise<void> {
  await updateState(req, res, "MONITOR", "MONITORING", "Action moved to monitoring. No external action was executed.");
}

export async function completeActionLedgerRow(req: Request, res: Response): Promise<void> {
  await updateState(req, res, "COMPLETED", "COMPLETED", "Action marked completed manually.");
}
