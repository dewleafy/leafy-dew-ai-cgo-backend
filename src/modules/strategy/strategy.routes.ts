import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getWeeklyStrategy } from "./strategy.service";

export const strategyRouter = Router();

strategyRouter.get(
  "/weekly",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    res.json({ ok: true, data: await getWeeklyStrategy(sellerId) });
  })
);
