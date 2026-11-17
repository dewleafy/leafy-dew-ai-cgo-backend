import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { instagramStatusController, instagramTestPostController } from "./instagram-publish.controller";

export const instagramPublishRouter = Router();

instagramPublishRouter.get("/status", asyncHandler(instagramStatusController));
instagramPublishRouter.post("/test-post", asyncHandler(instagramTestPostController));
