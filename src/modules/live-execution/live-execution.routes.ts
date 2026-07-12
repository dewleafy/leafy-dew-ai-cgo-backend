import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  dryRunLiveExecutionRoute,
  executeLiveExecutionRoute,
  getLiveExecutionForActionRoute,
  getLiveExecutionStatusRoute,
  listLiveExecutionRunsRoute,
  preflightLiveExecutionRoute
} from "./live-execution.controller";

export const liveExecutionRouter = Router();

liveExecutionRouter.get("/status", asyncHandler(getLiveExecutionStatusRoute));
liveExecutionRouter.post("/preflight/:actionId", asyncHandler(preflightLiveExecutionRoute));
liveExecutionRouter.post("/dry-run/:actionId", asyncHandler(dryRunLiveExecutionRoute));
liveExecutionRouter.post("/execute-live/:actionId", asyncHandler(executeLiveExecutionRoute));
liveExecutionRouter.get("/runs", asyncHandler(listLiveExecutionRunsRoute));
liveExecutionRouter.get("/action/:actionId", asyncHandler(getLiveExecutionForActionRoute));
