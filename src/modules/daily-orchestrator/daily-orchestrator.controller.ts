import { Request, Response } from "express";
import { z } from "zod";
import {
  DAILY_ORCHESTRATOR_SAFETY_METADATA,
  DailyOrchestratorSafeError,
  getDailyOrchestratorRunById,
  getDailyOrchestratorStatus,
  listDailyOrchestratorRuns,
  runDailyOrchestrator
} from "./daily-orchestrator.service";

const statusQuerySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default")
});

const runsQuerySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  limit: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      const numeric = Number(value ?? 20);
      return Number.isFinite(numeric) ? Math.min(Math.max(Math.floor(numeric), 1), 100) : 20;
    })
});

const runBodySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  actor: z.string().trim().min(1).optional().default("founder"),
  limit: z.number().int().min(1).max(50).optional().default(25),
  categories: z.array(z.string().trim().min(1)).optional().default([]),
  runType: z.string().trim().min(1).optional().default("MANUAL")
});

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the daily orchestrator input values.",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
}

function sendServiceError(res: Response, message: string, runId?: string): void {
  res.status(503).json({
    ok: false,
    runId,
    mode: "SHADOW",
    runStatus: "FAILED",
    metadata: DAILY_ORCHESTRATOR_SAFETY_METADATA,
    message,
    safeHint: "Run daily_orchestrator.sql, engine_registry.sql, and action_ledger.sql in Supabase, then retry."
  });
}

export async function getDailyOrchestratorStatusController(req: Request, res: Response): Promise<void> {
  const parsed = statusQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    res.json(await getDailyOrchestratorStatus(parsed.data.sellerId));
  } catch {
    sendServiceError(res, "Could not load Daily AI-CGO readiness status.");
  }
}

export async function postDailyOrchestratorRunController(req: Request, res: Response): Promise<void> {
  const parsed = runBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    res.json(await runDailyOrchestrator(parsed.data));
  } catch (error) {
    const runId = error instanceof DailyOrchestratorSafeError ? error.runId : undefined;
    sendServiceError(res, "Daily AI-CGO orchestration failed safely. No external action executed.", runId);
  }
}

export async function getDailyOrchestratorRunsController(req: Request, res: Response): Promise<void> {
  const parsed = runsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const runs = await listDailyOrchestratorRuns(parsed.data);
    res.json({
      ok: true,
      sellerId: parsed.data.sellerId,
      count: runs.length,
      runs
    });
  } catch {
    sendServiceError(res, "Could not load Daily AI-CGO orchestrator runs.");
  }
}

export async function getDailyOrchestratorRunDetailController(req: Request, res: Response): Promise<void> {
  const parsed = statusQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const run = await getDailyOrchestratorRunById({
      id: req.params.id,
      sellerId: parsed.data.sellerId
    });

    if (!run) {
      res.status(404).json({
        ok: false,
        message: "Daily orchestrator run was not found."
      });
      return;
    }

    res.json({
      ok: true,
      sellerId: parsed.data.sellerId,
      run
    });
  } catch {
    sendServiceError(res, "Could not load Daily AI-CGO orchestrator run detail.");
  }
}
