import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getDailyOrchestratorRunDetailController,
  getDailyOrchestratorRunsController,
  getDailyOrchestratorStatusController,
  postDailyOrchestratorRunController
} from "./daily-orchestrator.controller";

export const dailyOrchestratorRouter = Router();

dailyOrchestratorRouter.get("/status", asyncHandler(getDailyOrchestratorStatusController));
dailyOrchestratorRouter.post("/run", asyncHandler(postDailyOrchestratorRunController));
dailyOrchestratorRouter.get("/runs", asyncHandler(getDailyOrchestratorRunsController));
dailyOrchestratorRouter.get("/runs/:id", asyncHandler(getDailyOrchestratorRunDetailController));
