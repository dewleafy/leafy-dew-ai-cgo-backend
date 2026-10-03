import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getWeeklyPlaybooks } from "./playbooks.service";

export const playbooksRouter = Router();

playbooksRouter.get(
  "/weekly",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    res.json({ ok: true, data: await getWeeklyPlaybooks(sellerId) });
  })
);
