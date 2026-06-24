import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getAmazonAdsConfigCheck,
  getAmazonAdsConnectUrl,
  getAmazonAdsDbHealth,
  getAmazonAdsProfilesController,
  getAmazonAdsStatus,
  handleAmazonAdsCallback,
  postAmazonAdsDisconnect,
  postAmazonAdsTestConnection
} from "./amazon-ads.controller";

export const amazonAdsRouter = Router();

amazonAdsRouter.get("/config-check", asyncHandler(getAmazonAdsConfigCheck));
amazonAdsRouter.get("/db-health", asyncHandler(getAmazonAdsDbHealth));
amazonAdsRouter.get("/connect-url", asyncHandler(getAmazonAdsConnectUrl));
amazonAdsRouter.get("/callback", asyncHandler(handleAmazonAdsCallback));
amazonAdsRouter.get("/status", asyncHandler(getAmazonAdsStatus));
amazonAdsRouter.get("/profiles", asyncHandler(getAmazonAdsProfilesController));
amazonAdsRouter.post("/test-connection", asyncHandler(postAmazonAdsTestConnection));
amazonAdsRouter.post("/disconnect", asyncHandler(postAmazonAdsDisconnect));
