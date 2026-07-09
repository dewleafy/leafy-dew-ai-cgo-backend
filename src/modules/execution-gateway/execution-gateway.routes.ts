import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  executeLiveRoute,
  executeShadowRoute,
  getExecutionGatewayStatusRoute,
  listExecutionAttemptsForActionRoute,
  listExecutionAttemptsRoute,
  previewExecutionRoute
} from "./execution-gateway.controller";

export const executionGatewayRouter = Router();

executionGatewayRouter.get("/status", asyncHandler(getExecutionGatewayStatusRoute));
executionGatewayRouter.post("/preview/:actionId", asyncHandler(previewExecutionRoute));
executionGatewayRouter.post("/execute-shadow/:actionId", asyncHandler(executeShadowRoute));
executionGatewayRouter.post("/execute-live/:actionId", asyncHandler(executeLiveRoute));
executionGatewayRouter.get("/attempts", asyncHandler(listExecutionAttemptsRoute));
executionGatewayRouter.get("/action/:actionId", asyncHandler(listExecutionAttemptsForActionRoute));
