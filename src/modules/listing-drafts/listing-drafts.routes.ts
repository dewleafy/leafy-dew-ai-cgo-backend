import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  batchDeleteListingDraftsRoute,
  createListingDraftActionRoute,
  generateListingDraftsRoute,
  getListingDraftSummaryRoute,
  listListingDraftsForSkuRoute,
  listListingDraftsRoute
} from "./listing-drafts.controller";

export const listingDraftsRouter = Router();

listingDraftsRouter.get("/summary", asyncHandler(getListingDraftSummaryRoute));
listingDraftsRouter.get("/by-sku", asyncHandler(listListingDraftsForSkuRoute));
listingDraftsRouter.get(["", "/"], asyncHandler(listListingDraftsRoute));
listingDraftsRouter.post("/generate", asyncHandler(generateListingDraftsRoute));
listingDraftsRouter.post("/batch/delete", asyncHandler(batchDeleteListingDraftsRoute));
listingDraftsRouter.post("/:id/create-action", asyncHandler(createListingDraftActionRoute));
