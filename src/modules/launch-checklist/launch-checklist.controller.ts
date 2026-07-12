import { Request, Response } from "express";
import { getLaunchChecklistSummary, runLaunchChecklist } from "./launch-checklist.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function getLaunchChecklistSummaryRoute(req: Request, res: Response): Promise<void> {
  res.json(await getLaunchChecklistSummary(sellerIdFromQuery(req)));
}

export async function runLaunchChecklistRoute(req: Request, res: Response): Promise<void> {
  res.json(await runLaunchChecklist(sellerIdFromQuery(req)));
}
