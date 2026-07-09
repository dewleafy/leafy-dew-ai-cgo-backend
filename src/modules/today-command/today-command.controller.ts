import { Request, Response } from "express";
import { getTodayCommandSummary } from "./today-command.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function getTodayCommandSummaryRoute(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getTodayCommandSummary(sellerIdFromQuery(req)));
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not build Today Command summary."
    });
  }
}
