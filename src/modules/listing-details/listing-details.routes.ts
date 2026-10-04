import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getListingDetailsSummary } from "./listing-details.service";

export const listingDetailsRouter = Router();

listingDetailsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    res.json({ ok: true, data: await getListingDetailsSummary(sellerId) });
  })
);
