import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getBackgroundSyncStatusRoute } from "./background-sync.controller";

export const backgroundSyncRouter = Router();

backgroundSyncRouter.get("/status", asyncHandler(getBackgroundSyncStatusRoute));
