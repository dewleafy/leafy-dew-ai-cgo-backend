import { Request, Response } from "express";
import { z } from "zod";
import {
  getDailyEnginePlan,
  getEngineRouterSummary,
  listEngineRunLogs,
  runEngineRouterPreview,
  runSingleEnginePreview
} from "./engine-router.service";

const dailyPlanQuerySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  limit: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      const numeric = Number(value ?? 25);
      return Number.isFinite(numeric) ? Math.min(Math.max(Math.floor(numeric), 1), 100) : 25;
    })
});

const runLogsQuerySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  limit: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      const numeric = Number(value ?? 50);
      return Number.isFinite(numeric) ? Math.min(Math.max(Math.floor(numeric), 1), 200) : 50;
    })
});

const summaryQuerySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default")
});

const runPreviewBodySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  limit: z.number().int().min(1).max(50).optional().default(25),
  categories: z.array(z.string().trim().min(1)).optional(),
  actor: z.string().trim().min(1).optional().default("founder")
});

const runEngineBodySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  actor: z.string().trim().min(1).optional().default("founder")
});

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the engine router input values.",
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
    safeHint: "Run engine_registry.sql and action_ledger.sql in Supabase, then check the service role key."
  });
}

export async function getDailyPlanController(req: Request, res: Response): Promise<void> {
  const parsed = dailyPlanQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    res.json(await getDailyEnginePlan(parsed.data));
  } catch {
    sendDatabaseError(res, "Could not load daily engine plan from Supabase.");
  }
}

export async function postRunPreviewController(req: Request, res: Response): Promise<void> {
  const parsed = runPreviewBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    res.json(await runEngineRouterPreview(parsed.data));
  } catch {
    sendDatabaseError(res, "Could not run engine router preview.");
  }
}

export async function postRunSingleEngineController(req: Request, res: Response): Promise<void> {
  const parsed = runEngineBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const result = await runSingleEnginePreview({
      engineKey: req.params.engineKey,
      ...parsed.data
    });

    if (!result) {
      res.status(404).json({
        ok: false,
        message: "Enabled shadow-mode engine was not found."
      });
      return;
    }

    res.json({
      ok: true,
      sellerId: parsed.data.sellerId,
      runMode: "PREVIEW_ONLY",
      result
    });
  } catch {
    sendDatabaseError(res, "Could not run engine preview.");
  }
}

export async function getRunLogsController(req: Request, res: Response): Promise<void> {
  const parsed = runLogsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const logs = await listEngineRunLogs(parsed.data);
    res.json({
      ok: true,
      sellerId: parsed.data.sellerId,
      count: logs.length,
      logs
    });
  } catch {
    sendDatabaseError(res, "Could not load engine run logs from Supabase.");
  }
}

export async function getSummaryController(req: Request, res: Response): Promise<void> {
  const parsed = summaryQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    res.json(await getEngineRouterSummary(parsed.data.sellerId));
  } catch {
    sendDatabaseError(res, "Could not summarize engine router from Supabase.");
  }
}
