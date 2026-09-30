import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  dailyAmazonSpSyncController,
  debugAmazonSpOrderReportController,
  getAmazonSpCallbackController,
  getAmazonSpConfigCheckController,
  getAmazonSpConnectUrlController,
  getAmazonSpDoctorController,
  getAmazonSpSalesSummaryController,
  getAmazonSpStatusController,
  listAmazonSpReportJobsController,
  listAmazonSpListingsController,
  listAmazonSpOrdersController,
  listAmazonSpReturnsController,
  processAmazonSpReportJobsController,
  syncAmazonSpListingAttributesController,
  syncAmazonSpListingsController,
  syncAmazonSpOrderReportController,
  syncAmazonSpOrderReportChunkedController,
  syncAmazonSpOrdersController,
  syncAmazonSpReturnsReportController
} from "./amazon-sp.controller";

export const amazonSpRouter = Router();

amazonSpRouter.get("/config-check", asyncHandler(getAmazonSpConfigCheckController));
amazonSpRouter.get("/connect-url", asyncHandler(getAmazonSpConnectUrlController));
amazonSpRouter.get("/callback", asyncHandler(getAmazonSpCallbackController));
amazonSpRouter.get("/status", asyncHandler(getAmazonSpStatusController));
amazonSpRouter.get("/doctor", asyncHandler(getAmazonSpDoctorController));
amazonSpRouter.get("/sync-listings", asyncHandler(syncAmazonSpListingsController));
amazonSpRouter.post("/sync-listings", asyncHandler(syncAmazonSpListingsController));
amazonSpRouter.get("/sync-listing-attributes", asyncHandler(syncAmazonSpListingAttributesController));
amazonSpRouter.post("/sync-listing-attributes", asyncHandler(syncAmazonSpListingAttributesController));
amazonSpRouter.get("/listings", asyncHandler(listAmazonSpListingsController));
amazonSpRouter.get("/sync-orders", asyncHandler(syncAmazonSpOrdersController));
amazonSpRouter.post("/sync-orders", asyncHandler(syncAmazonSpOrdersController));
amazonSpRouter.get("/sync-order-report", asyncHandler(syncAmazonSpOrderReportController));
amazonSpRouter.get("/sync-returns-report", asyncHandler(syncAmazonSpReturnsReportController));
amazonSpRouter.post("/sync-returns-report", asyncHandler(syncAmazonSpReturnsReportController));
amazonSpRouter.get("/returns", asyncHandler(listAmazonSpReturnsController));
amazonSpRouter.get("/sync-order-report-chunked", asyncHandler(syncAmazonSpOrderReportChunkedController));
amazonSpRouter.get("/debug-order-report", asyncHandler(debugAmazonSpOrderReportController));
amazonSpRouter.get("/daily-sync", asyncHandler(dailyAmazonSpSyncController));
amazonSpRouter.post("/daily-sync", asyncHandler(dailyAmazonSpSyncController));
amazonSpRouter.get("/process-report-jobs", asyncHandler(processAmazonSpReportJobsController));
amazonSpRouter.post("/process-report-jobs", asyncHandler(processAmazonSpReportJobsController));
amazonSpRouter.get("/report-jobs", asyncHandler(listAmazonSpReportJobsController));
amazonSpRouter.get("/orders", asyncHandler(listAmazonSpOrdersController));
amazonSpRouter.get("/sales-summary", asyncHandler(getAmazonSpSalesSummaryController));
