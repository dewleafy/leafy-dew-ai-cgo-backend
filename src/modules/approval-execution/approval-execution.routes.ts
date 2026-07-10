import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getApprovalExecutionSummaryRoute,
  getReadyActionsRoute,
  liveExecuteApprovedActionRoute,
  previewApprovedActionRoute,
  shadowExecuteApprovedActionRoute
} from "./approval-execution.controller";

export const approvalExecutionRouter = Router();

approvalExecutionRouter.get("/ready-actions", asyncHandler(getReadyActionsRoute));
approvalExecutionRouter.get("/summary", asyncHandler(getApprovalExecutionSummaryRoute));
approvalExecutionRouter.post("/preview/:actionId", asyncHandler(previewApprovedActionRoute));
approvalExecutionRouter.post("/execute-shadow/:actionId", asyncHandler(shadowExecuteApprovedActionRoute));
approvalExecutionRouter.post("/execute-live/:actionId", asyncHandler(liveExecuteApprovedActionRoute));
