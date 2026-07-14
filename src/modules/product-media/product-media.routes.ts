import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getProductMediaDebugController,
  postManualProductMediaController,
  postProductMediaCatalogSyncController
} from "./product-media.controller";

export const productMediaRouter = Router();

productMediaRouter.get("/debug", asyncHandler(getProductMediaDebugController));
productMediaRouter.post("/sync-catalog-images", asyncHandler(postProductMediaCatalogSyncController));
productMediaRouter.post("/manual", asyncHandler(postManualProductMediaController));
