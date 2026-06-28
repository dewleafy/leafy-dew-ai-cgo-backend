import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getAutomationSettings,
  postResetAutomationSettings,
  putAutomationSettings
} from "./automation-settings.controller";

export const automationSettingsRoutes = Router();

automationSettingsRoutes.get(["", "/"], asyncHandler(getAutomationSettings));
automationSettingsRoutes.put(["", "/"], asyncHandler(putAutomationSettings));
automationSettingsRoutes.post("/reset", asyncHandler(postResetAutomationSettings));
