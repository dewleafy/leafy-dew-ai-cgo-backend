import { Request, Response } from "express";
import { getLaunchGateSummary, runLaunchGateChecks } from "./launch-gate.service";

function sellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

export async function getLaunchGateSummaryRoute(req: Request, res: Response): Promise<void> {
  res.json(await getLaunchGateSummary(sellerIdFromQuery(req)));
}

export async function runLaunchGateChecksRoute(req: Request, res: Response): Promise<void> {
  res.json(await runLaunchGateChecks(sellerIdFromQuery(req)));
}
