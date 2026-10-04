import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getListingDetailsSummary } from "./listing-details.service";
import { syncListingCatalog } from "./listing-catalog.service";

export const listingDetailsRouter = Router();

listingDetailsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    res.json({ ok: true, data: await getListingDetailsSummary(sellerId) });
  })
);

listingDetailsRouter.post(
  "/sync-catalog",
  asyncHandler(async (req, res) => {
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    const limit = Number(req.query.limit) || 25;
    res.json({ ok: true, data: await syncListingCatalog({ sellerId, limit }) });
  })
);
