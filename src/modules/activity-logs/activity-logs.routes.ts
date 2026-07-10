import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteActivityLogById,
  getActivityLog,
  getActivityLogEvents,
  getActivityLogSummaryRoute,
  getActivityLogs,
  postActivityLog,
  postActivityLogEvent
} from "./activity-logs.controller";

export const activityLogRoutes = Router();

activityLogRoutes.get(["", "/"], asyncHandler(getActivityLogs));
activityLogRoutes.get("/summary", asyncHandler(getActivityLogSummaryRoute));
activityLogRoutes.get("/events", asyncHandler(getActivityLogEvents));
activityLogRoutes.post("/record", asyncHandler(postActivityLogEvent));
activityLogRoutes.get("/:id", asyncHandler(getActivityLog));
activityLogRoutes.post(["", "/"], asyncHandler(postActivityLog));
activityLogRoutes.delete("/:id", asyncHandler(deleteActivityLogById));
