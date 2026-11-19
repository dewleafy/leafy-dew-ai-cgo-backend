import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/async-handler";
import { prepareUpcomingMedia } from "./creative-studio.service";

export const creativeStudioRouter = Router();

// Makes missing pictures and videos now. forceIds lets the owner release a held greeting after checking it.
creativeStudioRouter.post("/prepare", asyncHandler(async (req, res) => {
  const parsed = z.object({ forceIds: z.array(z.string().uuid()).max(10).optional(), days: z.number().int().min(1).max(14).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, message: "Check the request." }); return; }
  res.json({ ok: true, ...(await prepareUpcomingMedia(parsed.data)) });
}));
