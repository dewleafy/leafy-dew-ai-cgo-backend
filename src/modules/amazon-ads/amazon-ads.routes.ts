import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getAmazonAdsConfigCheck,
  getAmazonAdsConnectUrl,
  getAmazonAdsCampaigns,
  getAmazonAdsCampaignDailyMetrics,
  getAmazonAdsDbHealth,
  getAmazonAdsProfilesController,
  getAmazonAdsReportJob,
  getAmazonAdsSavedCampaigns,
  getAmazonAdsStatus,
  handleAmazonAdsCallback,
  postAmazonAdsBackfillCampaignReports,
  postAmazonAdsDownloadCampaignReport,
  postAmazonAdsDisconnect,
  postAmazonAdsProcessCampaignReportJobs,
  postAmazonAdsRequestCampaignReport,
  postAmazonAdsSyncCampaigns,
  postAmazonAdsTestConnection
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
amazonAdsRouter.get("/report-job/:jobId", asyncHandler(getAmazonAdsReportJob));
amazonAdsRouter.post("/request-campaign-report", asyncHandler(postAmazonAdsRequestCampaignReport));
amazonAdsRouter.post("/download-campaign-report/:jobId", asyncHandler(postAmazonAdsDownloadCampaignReport));
amazonAdsRouter.post("/backfill-campaign-reports", asyncHandler(postAmazonAdsBackfillCampaignReports));
amazonAdsRouter.post("/process-campaign-report-jobs", asyncHandler(postAmazonAdsProcessCampaignReportJobs));
amazonAdsRouter.post("/sync-campaigns", asyncHandler(postAmazonAdsSyncCampaigns));
amazonAdsRouter.post("/test-connection", asyncHandler(postAmazonAdsTestConnection));
amazonAdsRouter.post("/disconnect", asyncHandler(postAmazonAdsDisconnect));
