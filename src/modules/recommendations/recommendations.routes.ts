import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  approveRecommendation,
  completeRecommendation,
  getRecommendationById,
  getRecommendations,
  monitorRecommendation,
  rejectRecommendation
} from "./recommendations.controller";

export const recommendationsRouter = Router();

recommendationsRouter.get("/", asyncHandler(getRecommendations));
recommendationsRouter.get("/:id", asyncHandler(getRecommendationById));
recommendationsRouter.post("/:id/approve", asyncHandler(approveRecommendation));
recommendationsRouter.post("/:id/reject", asyncHandler(rejectRecommendation));
recommendationsRouter.post("/:id/monitor", asyncHandler(monitorRecommendation));
recommendationsRouter.post("/:id/complete", asyncHandler(completeRecommendation));
