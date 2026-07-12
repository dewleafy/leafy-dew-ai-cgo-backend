import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getLaunchChecklistSummaryRoute, runLaunchChecklistRoute } from "./launch-checklist.controller";

export const launchChecklistRouter = Router();

launchChecklistRouter.get("/summary", asyncHandler(getLaunchChecklistSummaryRoute));
launchChecklistRouter.post("/run", asyncHandler(runLaunchChecklistRoute));
