import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteAssetController,
  listAssetsController,
  registerAssetController,
  uploadUrlController
} from "./social-media.controller";

export const socialMediaRouter = Router();

socialMediaRouter.get("/assets", asyncHandler(listAssetsController));
socialMediaRouter.post("/upload-url", asyncHandler(uploadUrlController));
socialMediaRouter.post("/assets", asyncHandler(registerAssetController));
socialMediaRouter.delete("/assets/:id", asyncHandler(deleteAssetController));
