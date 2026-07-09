import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getSafetyControlStatusRoute,
  initializeSafetyControlRoute,
  listSafetyAuditEventsRoute,
  patchSafetyControlSettingsRoute
} from "./safety-control.controller";

export const safetyControlRouter = Router();

safetyControlRouter.get("/status", asyncHandler(getSafetyControlStatusRoute));
safetyControlRouter.post("/initialize", asyncHandler(initializeSafetyControlRoute));
safetyControlRouter.patch("/settings", asyncHandler(patchSafetyControlSettingsRoute));
safetyControlRouter.get("/audit-events", asyncHandler(listSafetyAuditEventsRoute));
