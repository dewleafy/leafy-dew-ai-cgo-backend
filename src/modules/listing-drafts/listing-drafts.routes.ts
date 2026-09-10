import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  batchDeleteListingDraftsRoute,
  createListingDraftActionRoute,
  generateListingDraftsRoute,
  getListingDraftSummaryRoute,
  listListingDraftsRoute
} from "./listing-drafts.controller";

export const listingDraftsRouter = Router();

listingDraftsRouter.get("/summary", asyncHandler(getListingDraftSummaryRoute));
listingDraftsRouter.get(["", "/"], asyncHandler(listListingDraftsRoute));
listingDraftsRouter.post("/generate", asyncHandler(generateListingDraftsRoute));
listingDraftsRouter.post("/batch/delete", asyncHandler(batchDeleteListingDraftsRoute));
listingDraftsRouter.post("/:id/create-action", asyncHandler(createListingDraftActionRoute));
