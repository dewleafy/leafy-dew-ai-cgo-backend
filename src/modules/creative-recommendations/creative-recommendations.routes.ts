import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  createCreativeRecommendationActionRoute,
  generateCreativeRecommendationsRoute,
  getCreativeRecommendationSummaryRoute,
  listCreativeRecommendationsRoute
} from "./creative-recommendations.controller";

export const creativeRecommendationsRouter = Router();

creativeRecommendationsRouter.get("/summary", asyncHandler(getCreativeRecommendationSummaryRoute));
creativeRecommendationsRouter.get(["", "/"], asyncHandler(listCreativeRecommendationsRoute));
creativeRecommendationsRouter.post("/generate", asyncHandler(generateCreativeRecommendationsRoute));
creativeRecommendationsRouter.post("/:id/create-action", asyncHandler(createCreativeRecommendationActionRoute));
