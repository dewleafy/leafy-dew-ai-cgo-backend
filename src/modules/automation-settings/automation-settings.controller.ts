import { Request, Response } from "express";
import { z } from "zod";
import {
  getOrCreateAutomationSettings,
  isAutomationMode,
  resetAutomationSettings,
  upsertAutomationSettings
} from "./automation-settings.service";
import { AutomationMode } from "./automation-settings.types";

const nullableTextSchema = z
  .string()
  .optional()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const modeSchema = z.string().transform((value, context) => {
  if (!isAutomationMode(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mode is not allowed."
    });
    return z.NEVER;
  }

  return value;
});

const automationSettingsSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  mode: modeSchema.optional(),
  maxDailyRecommendations: z.number().int().min(1).max(100).optional(),
  targetAcosDefault: z.number().finite().min(0).max(500).optional(),
  minProfitLowPrice: z.number().finite().min(0).optional(),
  minProfitMidPrice: z.number().finite().min(0).optional(),
  allowAutoNegative: z.boolean().optional(),
  allowAutoBidChange: z.boolean().optional(),
  allowAutoBudgetChange: z.boolean().optional(),
  allowAutoKeywordAdd: z.boolean().optional(),
  allowAutoProductTargetAdd: z.boolean().optional(),
  allowAutoListingChange: z.boolean().optional(),
  allowAutoPriceChange: z.boolean().optional(),
  approvalRequiredForTier2: z.boolean().optional(),
  approvalRequiredForTier3: z.boolean().optional(),
  shadowModeDays: z.number().int().min(1).max(365).optional(),
  notes: nullableTextSchema
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the automation settings input values.",
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
    safeHint: "Run automation_settings.sql in Supabase and check the service role key."
  });
}

export async function getAutomationSettings(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const result = await getOrCreateAutomationSettings(sellerId);

    res.json({
      ok: true,
      sellerId: result.settings.sellerId,
      settings: result.settings,
      warnings: result.warnings
    });
  } catch {
    sendDatabaseError(res, "Could not load automation settings from Supabase.");
  }
}

export async function putAutomationSettings(req: Request, res: Response): Promise<void> {
  const parsed = automationSettingsSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const result = await upsertAutomationSettings({
      ...parsed.data,
      mode: parsed.data.mode as AutomationMode | undefined
    });

    res.json({
      ok: true,
      sellerId: result.settings.sellerId,
      settings: result.settings,
      warnings: result.warnings
    });
  } catch {
    sendDatabaseError(res, "Could not save automation settings in Supabase.");
  }
}

export async function postResetAutomationSettings(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const result = await resetAutomationSettings(sellerId);

    res.json({
      ok: true,
      sellerId: result.settings.sellerId,
      settings: result.settings,
      warnings: result.warnings
    });
  } catch {
    sendDatabaseError(res, "Could not reset automation settings in Supabase.");
  }
}
