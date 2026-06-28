import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteActivityLogById,
  getActivityLog,
  getActivityLogs,
  postActivityLog
} from "./activity-logs.controller";

export const activityLogRoutes = Router();

activityLogRoutes.get(["", "/"], asyncHandler(getActivityLogs));
activityLogRoutes.get("/:id", asyncHandler(getActivityLog));
activityLogRoutes.post(["", "/"], asyncHandler(postActivityLog));
activityLogRoutes.delete("/:id", asyncHandler(deleteActivityLogById));
