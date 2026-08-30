import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getAplusContentPreviewRoute } from "./aplus-content.controller";

export const aplusContentRouter = Router();

aplusContentRouter.get("/preview", asyncHandler(getAplusContentPreviewRoute));
