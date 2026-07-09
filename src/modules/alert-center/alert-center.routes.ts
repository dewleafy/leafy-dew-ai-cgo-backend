import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  acknowledgeAlertEventRoute,
  generateAlertsRoute,
  getAlertSummaryRoute,
  listAlertEventsRoute,
  resolveAlertEventRoute,
  seedAlertRulesRoute
} from "./alert-center.controller";

export const alertCenterRouter = Router();

alertCenterRouter.get("/summary", asyncHandler(getAlertSummaryRoute));
alertCenterRouter.get("/events", asyncHandler(listAlertEventsRoute));
alertCenterRouter.post("/generate", asyncHandler(generateAlertsRoute));
alertCenterRouter.post("/seed-rules", asyncHandler(seedAlertRulesRoute));
alertCenterRouter.post("/events/:id/acknowledge", asyncHandler(acknowledgeAlertEventRoute));
alertCenterRouter.post("/events/:id/resolve", asyncHandler(resolveAlertEventRoute));
