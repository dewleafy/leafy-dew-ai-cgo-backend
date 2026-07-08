import { Request, Response } from "express";
import { z } from "zod";
import {
  createEngineRunPreview,
  getEngineRegistryRow,
  getEngineRegistrySummary,
  listEngineRegistryRows,
  seedEngineRegistry300,
  toggleEngineRegistryRow
} from "./engine-registry.service";

const listQuerySchema = z.object({
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  enabled: z
    .string()
    .trim()
    .transform((value, context) => {
      if (value === "true") return true;
      if (value === "false") return false;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enabled must be true or false."
      });
      return z.NEVER;
    })
    .optional(),
  limit: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      const numeric = Number(value ?? 300);
      return Number.isFinite(numeric) ? Math.min(Math.max(Math.floor(numeric), 1), 1000) : 300;
    })
});

const toggleBodySchema = z.object({
  enabled: z.boolean(),
  actor: z.string().trim().min(1).optional().default("founder"),
  note: z.string().trim().min(1).optional()
});

const runPreviewBodySchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  actor: z.string().trim().min(1).optional().default("founder")
});

function sendDatabaseError(res: Response, message: string): void {
  res.status(503).json({
    ok: false,
    message,
    safeHint: "Run engine_registry.sql in Supabase and check the service role key."
  });
}

function sendValidationError(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): void {
  res.status(400).json({
    ok: false,
    message: "Please check the engine registry input values.",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  });
}

export async function getEngineRegistry(req: Request, res: Response): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const engines = await listEngineRegistryRows(parsed.data);

    res.json({
      ok: true,
      count: engines.length,
      engines
    });
  } catch {
    sendDatabaseError(res, "Could not load engine registry from Supabase.");
  }
}

export async function getEngineRegistrySummaryController(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await getEngineRegistrySummary());
  } catch {
    sendDatabaseError(res, "Could not summarize engine registry from Supabase.");
  }
}

export async function getEngineRegistryDetail(req: Request, res: Response): Promise<void> {
  try {
    const engine = await getEngineRegistryRow(req.params.engineKey);

    if (!engine) {
      res.status(404).json({
        ok: false,
        message: "Engine was not found."
      });
      return;
    }

    res.json({
      ok: true,
      engine
    });
  } catch {
    sendDatabaseError(res, "Could not load engine registry detail from Supabase.");
  }
}

export async function postToggleEngineRegistry(req: Request, res: Response): Promise<void> {
  const parsed = toggleBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const engine = await toggleEngineRegistryRow({
      engineKey: req.params.engineKey,
      enabled: parsed.data.enabled
    });

    if (!engine) {
      res.status(404).json({
        ok: false,
        message: "Engine was not found."
      });
      return;
    }

    res.json({
      ok: true,
      engine,
      audit: {
        actor: parsed.data.actor,
        note: parsed.data.note ?? null,
        executedEngine: false
      }
    });
  } catch {
    sendDatabaseError(res, "Could not toggle engine registry row in Supabase.");
  }
}

export async function postRunPreviewEngineRegistry(req: Request, res: Response): Promise<void> {
  const parsed = runPreviewBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return;
  }

  try {
    const result = await createEngineRunPreview({
      engineKey: req.params.engineKey,
      sellerId: parsed.data.sellerId,
      actor: parsed.data.actor
    });

    res.json({
      ok: true,
      previewOnly: true,
      engine: result.engine,
      runLog: result.runLog,
      message: result.message,
      actionsCreatedCount: 0
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ENGINE_NOT_FOUND") {
      res.status(404).json({
        ok: false,
        message: "Engine was not found."
      });
      return;
    }

    sendDatabaseError(res, "Could not create engine run preview log in Supabase.");
  }
}

export async function postSeedEngineRegistry300(_req: Request, res: Response): Promise<void> {
  try {
    const result = await seedEngineRegistry300();

    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not seed engine registry rows.";
    res.status(503).json({
      ok: false,
      message,
      safeHint: "Seed validation runs before upsert. Check engine_registry.sql if Supabase writes fail."
    });
  }
}
