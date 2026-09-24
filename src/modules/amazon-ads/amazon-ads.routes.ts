import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getAmazonAdsAdvertisedProductDailyMetrics,
  getAmazonAdsConfigCheck,
  getAmazonAdsConnectUrl,
  getAmazonAdsCampaigns,
  getAmazonAdsCampaignDailyMetrics,
  getAmazonAdsDashboardSummary,
  getAmazonAdsDbHealth,
  getAmazonAdsProfilesController,
  getAmazonAdsPpcRecommendations,
  getAmazonAdsReportJob,
  getAmazonAdsSavedCampaigns,
  getAmazonAdsSearchTermDailyMetrics,
  getAmazonAdsSearchTermSummary,
  getAmazonAdsStatus,
  getAmazonAdsStoresProbe,
  getDaypartingHistoryController,
  getDaypartingSettingsController,
  getDaypartingStatusController,
  handleAmazonAdsCallback,
  postAmazonAdsBackfillAdvertisedProductReports,
  postAmazonAdsBackfillCampaignReports,
  postAmazonAdsBackfillSearchTermReports,
  postAmazonAdsDailyCampaignSync,
  postAmazonAdsDownloadAdvertisedProductReport,
  postAmazonAdsDownloadCampaignReport,
  postAmazonAdsDownloadSearchTermReport,
  postAmazonAdsDisconnect,
  postAmazonAdsProcessAdvertisedProductReportJobs,
  postAmazonAdsProcessCampaignReportJobs,
  postAmazonAdsProcessSearchTermReportJobs,
  postAmazonAdsRequestAdvertisedProductReport,
  postAmazonAdsRequestCampaignReport,
  postAmazonAdsRequestSearchTermReport,
  postAmazonAdsSyncCampaigns,
  postAmazonAdsTestConnection,
  postDaypartingRunNowController,
  putDaypartingSettingsController
} from "./amazon-ads.controller";

export const amazonAdsRouter = Router();

amazonAdsRouter.get("/config-check", asyncHandler(getAmazonAdsConfigCheck));
amazonAdsRouter.get("/db-health", asyncHandler(getAmazonAdsDbHealth));
amazonAdsRouter.get("/connect-url", asyncHandler(getAmazonAdsConnectUrl));
amazonAdsRouter.get("/callback", asyncHandler(handleAmazonAdsCallback));
amazonAdsRouter.get("/status", asyncHandler(getAmazonAdsStatus));
amazonAdsRouter.get("/profiles", asyncHandler(getAmazonAdsProfilesController));
amazonAdsRouter.get("/campaigns", asyncHandler(getAmazonAdsCampaigns));
amazonAdsRouter.get("/saved-campaigns", asyncHandler(getAmazonAdsSavedCampaigns));
amazonAdsRouter.get("/campaign-daily-metrics", asyncHandler(getAmazonAdsCampaignDailyMetrics));
amazonAdsRouter.get("/search-term-daily-metrics", asyncHandler(getAmazonAdsSearchTermDailyMetrics));
amazonAdsRouter.get("/search-term-summary", asyncHandler(getAmazonAdsSearchTermSummary));
amazonAdsRouter.get("/advertised-product-daily-metrics", asyncHandler(getAmazonAdsAdvertisedProductDailyMetrics));
amazonAdsRouter.get("/ppc-recommendations", asyncHandler(getAmazonAdsPpcRecommendations));
amazonAdsRouter.get("/dashboard-summary", asyncHandler(getAmazonAdsDashboardSummary));
amazonAdsRouter.get("/stores-probe", asyncHandler(getAmazonAdsStoresProbe));
amazonAdsRouter.get("/report-job/:jobId", asyncHandler(getAmazonAdsReportJob));
amazonAdsRouter.post("/request-campaign-report", asyncHandler(postAmazonAdsRequestCampaignReport));
amazonAdsRouter.post("/request-search-term-report", asyncHandler(postAmazonAdsRequestSearchTermReport));
amazonAdsRouter.post("/request-advertised-product-report", asyncHandler(postAmazonAdsRequestAdvertisedProductReport));
amazonAdsRouter.post("/download-campaign-report/:jobId", asyncHandler(postAmazonAdsDownloadCampaignReport));
amazonAdsRouter.post("/download-search-term-report/:jobId", asyncHandler(postAmazonAdsDownloadSearchTermReport));
amazonAdsRouter.post(
  "/download-advertised-product-report/:jobId",
  asyncHandler(postAmazonAdsDownloadAdvertisedProductReport)
);
amazonAdsRouter.post("/backfill-campaign-reports", asyncHandler(postAmazonAdsBackfillCampaignReports));
amazonAdsRouter.post("/backfill-search-term-reports", asyncHandler(postAmazonAdsBackfillSearchTermReports));
amazonAdsRouter.post(
  "/backfill-advertised-product-reports",
  asyncHandler(postAmazonAdsBackfillAdvertisedProductReports)
);
amazonAdsRouter.post("/process-campaign-report-jobs", asyncHandler(postAmazonAdsProcessCampaignReportJobs));
amazonAdsRouter.post("/process-search-term-report-jobs", asyncHandler(postAmazonAdsProcessSearchTermReportJobs));
amazonAdsRouter.post(
  "/process-advertised-product-report-jobs",
  asyncHandler(postAmazonAdsProcessAdvertisedProductReportJobs)
);
amazonAdsRouter.post("/daily-campaign-sync", asyncHandler(postAmazonAdsDailyCampaignSync));
amazonAdsRouter.post("/sync-campaigns", asyncHandler(postAmazonAdsSyncCampaigns));
amazonAdsRouter.post("/test-connection", asyncHandler(postAmazonAdsTestConnection));
amazonAdsRouter.post("/disconnect", asyncHandler(postAmazonAdsDisconnect));
amazonAdsRouter.get("/dayparting/settings", asyncHandler(getDaypartingSettingsController));
amazonAdsRouter.put("/dayparting/settings", asyncHandler(putDaypartingSettingsController));
amazonAdsRouter.get("/dayparting/status", asyncHandler(getDaypartingStatusController));
amazonAdsRouter.get("/dayparting/history", asyncHandler(getDaypartingHistoryController));
amazonAdsRouter.post("/dayparting/run-now", asyncHandler(postDaypartingRunNowController));
