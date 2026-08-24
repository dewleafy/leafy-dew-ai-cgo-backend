import { Request, Response } from "express";
import { getBackgroundAmazonSyncStatus } from "./background-sync.service";

export async function getBackgroundSyncStatusRoute(_req: Request, res: Response): Promise<void> {
  res.json({ ok: true, ...getBackgroundAmazonSyncStatus() });
}
