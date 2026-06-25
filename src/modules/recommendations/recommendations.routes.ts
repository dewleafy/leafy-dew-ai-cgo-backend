import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getRecommendations } from "./recommendations.controller";

export const recommendationsRouter = Router();

recommendationsRouter.get("/", asyncHandler(getRecommendations));
