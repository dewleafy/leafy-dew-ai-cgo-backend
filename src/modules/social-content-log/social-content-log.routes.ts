import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  createSocialContentLogController,
  deleteSocialContentLogController,
  listSocialContentLogController,
  updateSocialContentLogController
} from "./social-content-log.controller";

export const socialContentLogRouter = Router();

socialContentLogRouter.get(["", "/"], asyncHandler(listSocialContentLogController));
socialContentLogRouter.post(["", "/"], asyncHandler(createSocialContentLogController));
socialContentLogRouter.patch("/:id", asyncHandler(updateSocialContentLogController));
socialContentLogRouter.delete("/:id", asyncHandler(deleteSocialContentLogController));
