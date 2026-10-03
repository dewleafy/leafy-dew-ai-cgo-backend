import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getBrandHealth } from "./brand-health.service";

export const brandHealthRouter = Router();

brandHealthRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    res.json({ ok: true, data: await getBrandHealth(sellerId, 30) });
  })
);
