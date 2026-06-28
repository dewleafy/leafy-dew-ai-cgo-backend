import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getRecommendationOutcome,
  getRecommendationOutcomes,
  postEvaluateRecommendationOutcome,
  putRecommendationOutcome
} from "./recommendation-outcomes.controller";

export const recommendationOutcomeRoutes = Router();

recommendationOutcomeRoutes.get(["", "/"], asyncHandler(getRecommendationOutcomes));
recommendationOutcomeRoutes.get("/:id", asyncHandler(getRecommendationOutcome));
recommendationOutcomeRoutes.put("/:id", asyncHandler(putRecommendationOutcome));
recommendationOutcomeRoutes.post("/:id/evaluate", asyncHandler(postEvaluateRecommendationOutcome));
