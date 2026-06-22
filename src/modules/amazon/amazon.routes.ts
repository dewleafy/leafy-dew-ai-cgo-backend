import { Router } from "express";
import {
  getAmazonStatus,
  getConnectUrl,
  getMarketplaces,
  handleAmazonCallback,
  postDisconnect,
  postTestConnection
} from "./amazon.controller";
import { asyncHandler } from "../../utils/async-handler";

export const amazonRouter = Router();

amazonRouter.get("/connect-url", asyncHandler(getConnectUrl));
amazonRouter.get("/callback", asyncHandler(handleAmazonCallback));
amazonRouter.get("/status", asyncHandler(getAmazonStatus));
amazonRouter.post("/test-connection", asyncHandler(postTestConnection));
amazonRouter.get("/marketplaces", asyncHandler(getMarketplaces));
amazonRouter.post("/disconnect", asyncHandler(postDisconnect));
