import { Request, Response } from "express";
import { executeListingContentAction } from "./listing-execution.service";
import { ListingExecutionError } from "./listing-execution.types";

function sellerIdFromRequest(req: Request): string {
  const querySellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";
  const bodySellerId = typeof req.body?.sellerId === "string" ? req.body.sellerId.trim() : "";
  return querySellerId || bodySellerId || "default";
}

export async function postExecuteListingContentAction(req: Request, res: Response): Promise<void> {
  const sellerId = sellerIdFromRequest(req);
  const actionId = String(req.params.id || "");
  const actor = typeof req.body?.actor === "string" && req.body.actor.trim() ? req.body.actor.trim() : "founder";

  try {
    const result = await executeListingContentAction({ sellerId, actionId, actor });
    res.json(result);
  } catch (error) {
    if (error instanceof ListingExecutionError) {
      res.status(error.status).json({ ok: false, message: error.message });
      return;
    }

    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not send this listing change to Amazon."
    });
  }
}
