import { Request, Response } from "express";
import { executePassportDraftAction } from "./passport-draft-execution.service";
import { PassportDraftExecutionError } from "./passport-draft-execution.types";

function sellerIdFromRequest(req: Request): string {
  const querySellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const bodySellerId = typeof req.body?.sellerId === "string" ? req.body.sellerId.trim() : "";
  return querySellerId || bodySellerId || "default";
}

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
