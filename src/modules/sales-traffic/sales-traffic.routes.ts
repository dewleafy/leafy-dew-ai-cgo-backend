import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getSalesTrafficSummary } from "./sales-traffic.service";

export const salesTrafficRouter = Router();

salesTrafficRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    const days = typeof req.query.days === "string" ? Number(req.query.days) : 14;
    res.json({ ok: true, data: await getSalesTrafficSummary(sellerId, days) });
  })
);
