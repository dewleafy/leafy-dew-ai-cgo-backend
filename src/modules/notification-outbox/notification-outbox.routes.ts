import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getNotificationOutboxSummaryRoute,
  getNotificationSettingsRoute,
  initializeNotificationSettingsRoute,
  listNotificationMessagesRoute,
  queueNotificationRoute,
  sendNotificationRoute
} from "./notification-outbox.controller";

export const notificationOutboxRouter = Router();

notificationOutboxRouter.get("/summary", asyncHandler(getNotificationOutboxSummaryRoute));
notificationOutboxRouter.get("/messages", asyncHandler(listNotificationMessagesRoute));
notificationOutboxRouter.get("/settings", asyncHandler(getNotificationSettingsRoute));
notificationOutboxRouter.post("/initialize", asyncHandler(initializeNotificationSettingsRoute));
notificationOutboxRouter.post("/queue", asyncHandler(queueNotificationRoute));
notificationOutboxRouter.post("/send/:id", asyncHandler(sendNotificationRoute));
