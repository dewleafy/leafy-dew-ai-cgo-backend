import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getLaunchGateSummaryRoute, runLaunchGateChecksRoute } from "./launch-gate.controller";

export const launchGateRouter = Router();

launchGateRouter.get("/summary", asyncHandler(getLaunchGateSummaryRoute));
launchGateRouter.post("/run", asyncHandler(runLaunchGateChecksRoute));
