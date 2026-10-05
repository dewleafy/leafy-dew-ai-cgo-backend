import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getListingOptimizerAnalyses,
  getListingOptimizerAnalysisById,
  postListingOptimizerAnalyze
} from "./listing-optimizer.controller";

export const listingOptimizerRouter = Router();

listingOptimizerRouter.post("/analyze", asyncHandler(postListingOptimizerAnalyze));
listingOptimizerRouter.get("/analyses", asyncHandler(getListingOptimizerAnalyses));
listingOptimizerRouter.get("/analyses/:id", asyncHandler(getListingOptimizerAnalysisById));
