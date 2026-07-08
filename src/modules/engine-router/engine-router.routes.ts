import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getDailyPlanController,
  getRunLogsController,
  getSummaryController,
  postRunPreviewController,
  postRunSingleEngineController
} from "./engine-router.controller";

export const engineRouterRouter = Router();

engineRouterRouter.get("/daily-plan", asyncHandler(getDailyPlanController));
engineRouterRouter.post("/run-preview", asyncHandler(postRunPreviewController));
engineRouterRouter.post("/run-engine/:engineKey", asyncHandler(postRunSingleEngineController));
engineRouterRouter.get("/run-logs", asyncHandler(getRunLogsController));
engineRouterRouter.get("/summary", asyncHandler(getSummaryController));
