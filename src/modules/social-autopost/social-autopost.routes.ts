import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/async-handler";
import { getAutopostSettings, listAutopostLog, runAutopostOnce, setAutopostMode } from "./social-autopost.service";

export const socialAutopostRouter = Router();

socialAutopostRouter.get("/", asyncHandler(async (_req, res) => {
  res.json({ ok: true, settings: await getAutopostSettings(), log: await listAutopostLog() });
}));

socialAutopostRouter.put("/mode", asyncHandler(async (req, res) => {
  const parsed = z.object({ mode: z.enum(["OFF", "SHADOW", "LIVE"]) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, message: "Mode must be OFF, SHADOW or LIVE." }); return; }
  try {
    res.json({ ok: true, settings: await setAutopostMode(parsed.data.mode) });
  } catch (e) {
    res.status(400).json({ ok: false, message: e instanceof Error ? e.message : "Could not change mode." });
  }
}));

// Runs one check now. In SHADOW mode this publishes nothing.
socialAutopostRouter.post("/check-now", asyncHandler(async (_req, res) => {
  res.json({ ok: true, result: await runAutopostOnce(), log: await listAutopostLog() });
}));
