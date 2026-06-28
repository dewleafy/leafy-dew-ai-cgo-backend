import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getLearningSummary } from "./learning-summary.controller";

export const learningSummaryRoutes = Router();

learningSummaryRoutes.get(["", "/"], asyncHandler(getLearningSummary));
