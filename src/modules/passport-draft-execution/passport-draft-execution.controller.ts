import { Request, Response } from "express";
import { z } from "zod";
import { batchExecutePassportDraftActions, executePassportDraftAction } from "./passport-draft-execution.service";
import { PassportDraftExecutionError } from "./passport-draft-execution.types";

function sellerIdFromRequest(req: Request): string {
  const querySellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const bodySellerId = typeof req.body?.sellerId === "string" ? req.body.sellerId.trim() : "";
  return querySellerId || bodySellerId || "default";
}

const ACTION_ID_REGEX = /^[0-9a-f-]{8,64}$/i;

const batchExecuteSchema = z.object({
  sellerId: z.string().trim().min(1).optional().default("default"),
  ids: z
    .array(z.string().trim().regex(ACTION_ID_REGEX, "ids must contain valid action ledger ids."))
    .min(1, "ids must be a non-empty array.")
    .max(100, "Batch requests are limited to 100 ids."),
  actor: z.string().trim().optional()
});

export async function postExecutePassportDraftAction(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromRequest(req);
  const actionId = String(req.params.id || "");
  const actor = typeof req.body?.actor === "string" && req.body.actor.trim() ? req.body.actor.trim() : "founder";

  try {
    const result = await executePassportDraftAction({ sellerId, actionId, actor });
    res.json(result);
  } catch (error) {
    if (error instanceof PassportDraftExecutionError) {
      res.status(error.status).json({ ok: false, message: error.message });
      return;
    }

    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not save this draft to the Product Passport."
    });
  }
}

export async function postBatchExecutePassportDraftActions(req: Request, res: Response): Promise<void> {
  const parsed = batchExecuteSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid batch request." });
    return;
  }

  const { sellerId, ids, actor } = parsed.data;

  try {
    const result = await batchExecutePassportDraftActions({ sellerId, actionIds: ids, actor });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not batch save these drafts to the Product Passport."
    });
  }
}
