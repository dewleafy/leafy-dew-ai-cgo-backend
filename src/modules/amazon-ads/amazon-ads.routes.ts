import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
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
  handleAmazonAdsCallback,
  postAmazonAdsBackfillCampaignReports,
  postAmazonAdsBackfillSearchTermReports,
  postAmazonAdsDailyCampaignSync,
  postAmazonAdsDownloadCampaignReport,
  postAmazonAdsDownloadSearchTermReport,
  postAmazonAdsDisconnect,
  postAmazonAdsProcessCampaignReportJobs,
  postAmazonAdsProcessSearchTermReportJobs,
  postAmazonAdsRequestCampaignReport,
  postAmazonAdsRequestSearchTermReport,
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
amazonAdsRouter.get("/search-term-daily-metrics", asyncHandler(getAmazonAdsSearchTermDailyMetrics));
amazonAdsRouter.get("/search-term-summary", asyncHandler(getAmazonAdsSearchTermSummary));
amazonAdsRouter.get("/ppc-recommendations", asyncHandler(getAmazonAdsPpcRecommendations));
amazonAdsRouter.get("/dashboard-summary", asyncHandler(getAmazonAdsDashboardSummary));
amazonAdsRouter.get("/report-job/:jobId", asyncHandler(getAmazonAdsReportJob));
amazonAdsRouter.post("/request-campaign-report", asyncHandler(postAmazonAdsRequestCampaignReport));
amazonAdsRouter.post("/request-search-term-report", asyncHandler(postAmazonAdsRequestSearchTermReport));
amazonAdsRouter.post("/download-campaign-report/:jobId", asyncHandler(postAmazonAdsDownloadCampaignReport));
amazonAdsRouter.post("/download-search-term-report/:jobId", asyncHandler(postAmazonAdsDownloadSearchTermReport));
amazonAdsRouter.post("/backfill-campaign-reports", asyncHandler(postAmazonAdsBackfillCampaignReports));
amazonAdsRouter.post("/backfill-search-term-reports", asyncHandler(postAmazonAdsBackfillSearchTermReports));
amazonAdsRouter.post("/process-campaign-report-jobs", asyncHandler(postAmazonAdsProcessCampaignReportJobs));
amazonAdsRouter.post("/process-search-term-report-jobs", asyncHandler(postAmazonAdsProcessSearchTermReportJobs));
amazonAdsRouter.post("/daily-campaign-sync", asyncHandler(postAmazonAdsDailyCampaignSync));
amazonAdsRouter.post("/sync-campaigns", asyncHandler(postAmazonAdsSyncCampaigns));
amazonAdsRouter.post("/test-connection", asyncHandler(postAmazonAdsTestConnection));
amazonAdsRouter.post("/disconnect", asyncHandler(postAmazonAdsDisconnect));
