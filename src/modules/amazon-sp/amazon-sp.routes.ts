import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getAmazonSpCallbackController,
  getAmazonSpConfigCheckController,
  getAmazonSpConnectUrlController,
  getAmazonSpDoctorController,
  getAmazonSpSalesSummaryController,
  getAmazonSpStatusController,
  listAmazonSpListingsController,
  listAmazonSpOrdersController,
  syncAmazonSpListingsController,
  syncAmazonSpOrderReportController,
  syncAmazonSpOrdersController
} from "./amazon-sp.controller";

export const amazonSpRouter = Router();

amazonSpRouter.get("/config-check", asyncHandler(getAmazonSpConfigCheckController));
amazonSpRouter.get("/connect-url", asyncHandler(getAmazonSpConnectUrlController));
amazonSpRouter.get("/callback", asyncHandler(getAmazonSpCallbackController));
amazonSpRouter.get("/status", asyncHandler(getAmazonSpStatusController));
amazonSpRouter.get("/doctor", asyncHandler(getAmazonSpDoctorController));
amazonSpRouter.get("/sync-listings", asyncHandler(syncAmazonSpListingsController));
amazonSpRouter.post("/sync-listings", asyncHandler(syncAmazonSpListingsController));
amazonSpRouter.get("/listings", asyncHandler(listAmazonSpListingsController));
amazonSpRouter.get("/sync-orders", asyncHandler(syncAmazonSpOrdersController));
amazonSpRouter.post("/sync-orders", asyncHandler(syncAmazonSpOrdersController));
amazonSpRouter.get("/sync-order-report", asyncHandler(syncAmazonSpOrderReportController));
amazonSpRouter.get("/orders", asyncHandler(listAmazonSpOrdersController));
amazonSpRouter.get("/sales-summary", asyncHandler(getAmazonSpSalesSummaryController));
