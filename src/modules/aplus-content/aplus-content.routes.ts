import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getAplusContentCoverageRoute,
  getAplusContentPreviewRoute,
  scanAplusContentCoverageRoute
} from "./aplus-content.controller";

export const aplusContentRouter = Router();

aplusContentRouter.get("/preview", asyncHandler(getAplusContentPreviewRoute));
aplusContentRouter.get("/coverage", asyncHandler(getAplusContentCoverageRoute));
aplusContentRouter.post("/coverage/scan", asyncHandler(scanAplusContentCoverageRoute));
