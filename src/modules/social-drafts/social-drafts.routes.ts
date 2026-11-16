import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  createSocialDraftsController,
  listSocialDraftsController,
  updateSocialDraftController
} from "./social-drafts.controller";

export const socialDraftsRouter = Router();

socialDraftsRouter.get(["", "/"], asyncHandler(listSocialDraftsController));
socialDraftsRouter.post(["", "/"], asyncHandler(createSocialDraftsController));
socialDraftsRouter.patch("/:id", asyncHandler(updateSocialDraftController));
