import { Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  buildAmazonAdsConnectUrl,
  exchangeAmazonAdsAuthorizationCode,
  getAmazonAdsConfigCheck as readAmazonAdsConfigCheck,
  parseAmazonAdsState
} from "./amazon-ads-auth.service";
import {
  getAmazonAdsProfiles,
  getSponsoredProductsCampaigns,
  getSponsoredProductsCampaignsWithRaw,
  logSafeAmazonAdsSupabaseError
} from "./amazon-ads-client.service";
import {
  listSavedAmazonAdsCampaigns,
  saveAmazonAdsCampaigns
} from "./amazon-ads-campaign.service";
import {
  getFirstAmazonAdsProfile,
  listAmazonAdsProfiles,
  saveAmazonAdsProfiles
} from "./amazon-ads-profile.service";
import {
  getAmazonAdsPpcRecommendationDateRange,
  getAmazonAdsPpcRecommendations as buildAmazonAdsPpcRecommendations,
  saveAmazonAdsPpcRecommendations
} from "./amazon-ads-ppc-recommendation.service";
import { syncRecommendationsToActionLedger } from "../action-ledger/action-ledger-bridge.service";
import {
  downloadAndSaveCampaignReport,
  downloadAndSaveSearchTermReport,
  getCampaignDashboardSummary,
  getSearchTermSummary,
  hasActiveCampaignReportJobForDate,
  hasCampaignMetricsForDate,
  hasCampaignReportJobForDate,
  hasSearchTermMetricsForDate,
  hasSearchTermReportJobForDate,
  listCampaignDailyMetrics,
  listProcessableCampaignReportJobs,
  listProcessableSearchTermReportJobs,
  listSearchTermDailyMetrics,
  loadAmazonAdsConnectionById,
  loadAmazonAdsReportJob,
  markAmazonAdsReportJobSynced,
  refreshAmazonAdsReportJobStatus,
  requestSponsoredProductsCampaignReport,
  requestSponsoredProductsSearchTermReport
} from "./amazon-ads-report.service";
import {
  deleteAmazonAdsTokens,
  getAmazonAdsAccessToken,
  saveAmazonAdsRefreshToken
} from "./amazon-ads-token.service";
import { AmazonAdsConnection, AmazonAdsStoredProfile } from "./amazon-ads.types";

const sellerQuerySchema = z.object({
  sellerId: z.string().min(1)
});

const connectQuerySchema = z.object({
  sellerId: z.string().min(1).optional()
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1).optional()
});

const dateQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must use YYYY-MM-DD format");

function sendDatabaseFailure(res: Response, message = "Could not reach Supabase. Check your database settings."): void {
  res.status(503).json({
    ok: false,
    error: "Database connection failed",
    message,
    safeHint: "Check amazon_ads table schema and service role key."
  });
}

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getYesterdayDate(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getDateFromQuery(req: Request): string {
  const rawDate = typeof req.query.date === "string" ? req.query.date.trim() : "";

  if (!rawDate) {
    return getYesterdayDate();
  }

  return dateQuerySchema.parse(rawDate);
}

function getDaysFromQuery(req: Request): number {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 7;
  const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : 7;

  return Math.min(Math.max(days, 1), 30);
}

function getSummaryDaysFromQuery(req: Request): number {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 30;
  const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : 30;

  return Math.min(Math.max(days, 1), 30);
}

function getTargetAcosFromQuery(req: Request): number {
  const rawTargetAcos = typeof req.query.targetAcos === "string" ? Number(req.query.targetAcos) : 35;
  const targetAcos = Number.isFinite(rawTargetAcos) && rawTargetAcos > 0 ? rawTargetAcos : 35;

  return Math.round(targetAcos * 100) / 100;
}

function shouldSaveRecommendations(req: Request): boolean {
  return typeof req.query.save === "string" && req.query.save.toLowerCase() === "true";
}

function getLimitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 10;

  return Math.min(Math.max(limit, 1), 50);
}

function getBackfillDate(offsetDaysFromToday: number): string {
  return new Date(Date.now() - offsetDaysFromToday * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function hasValidCronSecret(req: Request): boolean {
  const configuredSecret = env.CRON_SECRET;
  const providedSecret = req.header("x-cron-secret");

  if (!configuredSecret || !providedSecret) {
    return false;
  }

  const configuredBuffer = Buffer.from(configuredSecret);
  const providedBuffer = Buffer.from(providedSecret);

  return (
    configuredBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(configuredBuffer, providedBuffer)
  );
}

function sendBeginnerError(res: Response, status: number, message: string): void {
  res.status(status).json({
    ok: false,
    message
  });
}

function getSafeAmazonAdsErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Please check your Amazon Ads credentials and try again.";
  }

  const secretValues = [
    env.AMAZON_ADS_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_ID,
    env.ENCRYPTION_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (message, secretValue) => message.replaceAll(secretValue, "[REDACTED]"),
    error.message
  );
}

function getSafeAmazonAdsUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return getSafeAmazonAdsErrorMessage(error);
  }

  return "Amazon Ads request failed. Please check your configuration and try again.";
}

async function findAmazonAdsConnectionBySellerId(
  sellerId: string
): Promise<{ ok: true; connection: AmazonAdsConnection | null } | { ok: false }> {
  try {
    const { data, error } = await supabase
      .from("amazon_ads_connections")
      .select("*")
      .eq("seller_id", sellerId)
      .maybeSingle<AmazonAdsConnection>();

    if (error) {
      logger.warn("Could not load Amazon Ads connection.", {
        sellerId,
        message: error.message
      });
      return { ok: false };
    }

    return { ok: true, connection: data };
  } catch (error) {
    logger.warn("Could not reach Supabase for Amazon Ads connection lookup.", {
      sellerId,
      message: error instanceof Error ? error.message : "Unknown database error"
    });
    return { ok: false };
  }
}

async function findAmazonAdsConnectionForCampaigns(
  sellerId: string
): Promise<{ ok: true; connection: AmazonAdsConnection | null } | { ok: false }> {
  try {
    let query = supabase
      .from("amazon_ads_connections")
      .select("*")
      .eq("status", "connected")
      .order("connected_at", { ascending: false })
      .limit(1);

    if (sellerId !== "default") {
      query = query.eq("seller_id", sellerId);
    }

    const { data, error } = await query.maybeSingle<AmazonAdsConnection>();

    if (error) {
      logSafeAmazonAdsSupabaseError("Could not load Amazon Ads connection for campaigns.", error);
      return { ok: false };
    }

    return { ok: true, connection: data };
  } catch (error) {
    logger.warn("Could not reach Supabase for Amazon Ads campaigns connection lookup.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });
    return { ok: false };
  }
}

async function loadAmazonAdsCampaignContext(
  sellerId: string
): Promise<
  | { ok: true; connection: AmazonAdsConnection; profile: AmazonAdsStoredProfile }
  | { ok: false; status: number; message: string; database?: boolean }
> {
  const lookup = await findAmazonAdsConnectionForCampaigns(sellerId);

  if (!lookup.ok) {
    return {
      ok: false,
      status: 503,
      database: true,
      message: "Could not load Amazon Ads connection for campaigns."
    };
  }

  if (!lookup.connection) {
    return {
      ok: false,
      status: 404,
      message: "No connected Amazon Ads account found. Connect Amazon Ads first."
    };
  }

  const profile = await getFirstAmazonAdsProfile(lookup.connection.id);

  if (!profile) {
    return {
      ok: false,
      status: 404,
      message: "No Amazon Ads profile found. Reconnect Amazon Ads to sync profiles."
    };
  }

  return {
    ok: true,
    connection: lookup.connection,
    profile
  };
}

async function processAmazonAdsCampaignReportJobsForContext(input: {
  context: { connection: AmazonAdsConnection; profile: AmazonAdsStoredProfile };
  sellerId: string;
  limit: number;
}): Promise<{
  checkedCount: number;
  syncedCount: number;
  pendingCount: number;
  failedCount: number;
  results: Array<{ jobId: string; date: string; status: string; syncedCount: number }>;
}> {
  const reportSellerId = input.context.connection.seller_id ?? input.sellerId;
  const accessToken = await getAmazonAdsAccessToken(input.context.connection.id);
  const jobs = await listProcessableCampaignReportJobs({
    connectionId: input.context.connection.id,
    profileId: input.context.profile.profile_id,
    sellerId: reportSellerId,
    limit: input.limit
  });
  const results: Array<{ jobId: string; date: string; status: string; syncedCount: number }> = [];
  let syncedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;

  for (const job of jobs) {
    const refreshedJob = await refreshAmazonAdsReportJobStatus({
      accessToken,
      region: input.context.connection.region,
      job
    });
    const status = refreshedJob.status.toUpperCase();
    let jobSyncedCount = 0;

    if (status === "COMPLETED" && refreshedJob.report_url) {
      jobSyncedCount = await downloadAndSaveCampaignReport(refreshedJob);
      await markAmazonAdsReportJobSynced(refreshedJob.id);
      syncedCount += 1;
      results.push({
        jobId: refreshedJob.id,
        date: refreshedJob.start_date,
        status: "SYNCED",
        syncedCount: jobSyncedCount
      });
      continue;
    }

    if (["FAILED", "FAILURE", "CANCELLED", "CANCELED"].includes(status)) {
      failedCount += 1;
    } else {
      pendingCount += 1;
    }

    results.push({
      jobId: refreshedJob.id,
      date: refreshedJob.start_date,
      status: refreshedJob.status,
      syncedCount: 0
    });
  }

  return {
    checkedCount: jobs.length,
    syncedCount,
    pendingCount,
    failedCount,
    results
  };
}

async function processAmazonAdsSearchTermReportJobsForContext(input: {
  context: { connection: AmazonAdsConnection; profile: AmazonAdsStoredProfile };
  sellerId: string;
  limit: number;
}): Promise<{
  checkedCount: number;
  syncedCount: number;
  pendingCount: number;
  failedCount: number;
  results: Array<{ jobId: string; date: string; status: string; syncedCount: number }>;
}> {
  const reportSellerId = input.context.connection.seller_id ?? input.sellerId;
  const accessToken = await getAmazonAdsAccessToken(input.context.connection.id);
  const jobs = await listProcessableSearchTermReportJobs({
    connectionId: input.context.connection.id,
    profileId: input.context.profile.profile_id,
    sellerId: reportSellerId,
    limit: input.limit
  });
  const results: Array<{ jobId: string; date: string; status: string; syncedCount: number }> = [];
  let syncedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;

  for (const job of jobs) {
    const refreshedJob = await refreshAmazonAdsReportJobStatus({
      accessToken,
      region: input.context.connection.region,
      job
    });
    const status = refreshedJob.status.toUpperCase();
    let jobSyncedCount = 0;

    if (status === "COMPLETED" && refreshedJob.report_url) {
      jobSyncedCount = await downloadAndSaveSearchTermReport(refreshedJob);
      await markAmazonAdsReportJobSynced(refreshedJob.id);
      syncedCount += 1;
      results.push({
        jobId: refreshedJob.id,
        date: refreshedJob.start_date,
        status: "SYNCED",
        syncedCount: jobSyncedCount
      });
      continue;
    }

    if (["FAILED", "FAILURE", "CANCELLED", "CANCELED"].includes(status)) {
      failedCount += 1;
    } else {
      pendingCount += 1;
    }

    results.push({
      jobId: refreshedJob.id,
      date: refreshedJob.start_date,
      status: refreshedJob.status,
      syncedCount: 0
    });
  }

  return {
    checkedCount: jobs.length,
    syncedCount,
    pendingCount,
    failedCount,
    results
  };
}

export async function getAmazonAdsConfigCheck(_req: Request, res: Response): Promise<void> {
  res.json(readAmazonAdsConfigCheck());
}

export async function getAmazonAdsConnectUrl(req: Request, res: Response): Promise<void> {
  try {
    const query = connectQuerySchema.parse(req.query);
    const result = buildAmazonAdsConnectUrl(query.sellerId);

    res.json({
      ok: true,
      authorizationUrl: result.authorizationUrl,
      state: result.state
    });
  } catch (error) {
    sendBeginnerError(
      res,
      400,
      error instanceof Error
        ? error.message
        : "Could not create Amazon Ads connection URL. Check Amazon Ads environment variables."
    );
  }
}

export async function handleAmazonAdsCallback(req: Request, res: Response): Promise<void> {
  try {
    const query = callbackQuerySchema.parse(req.query);
    const state = query.state
      ? parseAmazonAdsState(query.state)
      : {
          sellerId: undefined,
          region: env.AMAZON_ADS_REGION,
          nonce: null
        };

    if (!query.state) {
      logger.warn("Amazon Ads callback did not include OAuth state. Continuing with default region.", {
        region: env.AMAZON_ADS_REGION
      });
    }

    const tokenResponse = await exchangeAmazonAdsAuthorizationCode(query.code);

    const { data: connection, error } = await supabase
      .from("amazon_ads_connections")
      .insert({
        seller_id: state.sellerId ?? null,
        region: state.region,
        status: "connected",
        state_nonce: state.nonce,
        connected_at: new Date().toISOString()
      })
      .select("*")
      .single<AmazonAdsConnection>();

    if (error || !connection) {
      if (error) {
        logSafeAmazonAdsSupabaseError("Could not save Amazon Ads connection.", error);
      }
      sendDatabaseFailure(res, "Could not save Amazon Ads connection in Supabase.");
      return;
    }

    await saveAmazonAdsRefreshToken(connection.id, tokenResponse);

    try {
      const profiles = await getAmazonAdsProfiles(tokenResponse.access_token, connection.region, connection.id);
      await saveAmazonAdsProfiles(connection.id, profiles);

      res.json({
        ok: true,
        message: "Amazon Ads account connected successfully",
        profilesCount: profiles.length
      });
      return;
    } catch (profileError) {
      logger.warn("Amazon Ads connected, but profile sync failed safely.", {
        connectionId: connection.id,
        message: getSafeAmazonAdsUnknownErrorMessage(profileError)
      });

      res.json({
        ok: true,
        message: "Amazon Ads account connected successfully, but profiles could not be synced yet.",
        profilesCount: 0
      });
      return;
    }
  } catch (error) {
    logger.warn("Amazon Ads callback failed safely.", {
      message: getSafeAmazonAdsErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Amazon Ads authorization failed",
      details: getSafeAmazonAdsErrorMessage(error)
    });
  }
}

export async function getAmazonAdsStatus(req: Request, res: Response): Promise<void> {
  const sellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

  if (!sellerId) {
    res.json({
      ok: true,
      connected: false,
      message: "No sellerId provided. No Amazon Ads account connected yet."
    });
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  const connection = lookup.connection;

  res.json({
    ok: true,
    connected: connection?.status === "connected",
    connection: connection
      ? {
          sellerId: connection.seller_id,
          region: connection.region,
          status: connection.status,
          connectedAt: connection.connected_at,
          disconnectedAt: connection.disconnected_at
        }
      : null
  });
}

export async function getAmazonAdsProfilesController(req: Request, res: Response): Promise<void> {
  const query = sellerQuerySchema.safeParse(req.query);

  if (!query.success) {
    sendBeginnerError(res, 400, "sellerId is required to load Amazon Ads profiles.");
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(query.data.sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  if (!lookup.connection) {
    sendBeginnerError(res, 404, "No Amazon Ads connection found for this sellerId.");
    return;
  }

  const profiles = await listAmazonAdsProfiles(lookup.connection.id);

  res.json({
    ok: true,
    profiles
  });
}

export async function getAmazonAdsCampaigns(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const campaigns = await getSponsoredProductsCampaigns({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      campaigns
    });
  } catch (error) {
    logger.warn("Amazon Ads campaigns request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads campaigns.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsSyncCampaigns(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const campaigns = await getSponsoredProductsCampaignsWithRaw({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id
    });

    const syncedCount = await saveAmazonAdsCampaigns({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      sellerId: context.connection.seller_id ?? sellerId,
      campaigns
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      syncedCount
    });
  } catch (error) {
    logger.warn("Amazon Ads campaign sync failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not sync Amazon Ads campaigns.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsSavedCampaigns(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const campaigns = await listSavedAmazonAdsCampaigns({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      campaigns
    });
  } catch (error) {
    logger.warn("Saved Amazon Ads campaigns request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load saved Amazon Ads campaigns.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsRequestCampaignReport(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const date = getDateFromQuery(req);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const job = await requestSponsoredProductsCampaignReport({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id,
      sellerId: context.connection.seller_id ?? sellerId,
      date
    });

    res.json({
      ok: true,
      jobId: job.jobId,
      reportId: job.reportId,
      status: job.status,
      date
    });
  } catch (error) {
    logger.warn("Amazon Ads campaign report request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not request Amazon Ads campaign report.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsRequestSearchTermReport(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const date = getDateFromQuery(req);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const job = await requestSponsoredProductsSearchTermReport({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id,
      sellerId: context.connection.seller_id ?? sellerId,
      date
    });

    res.json({
      ok: true,
      jobId: job.jobId,
      reportId: job.reportId,
      status: job.status,
      date
    });
  } catch (error) {
    logger.warn("Amazon Ads search term report request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not request Amazon Ads search term report.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsReportJob(req: Request, res: Response): Promise<void> {
  const jobId = req.params.jobId;

  try {
    const job = await loadAmazonAdsReportJob(jobId);
    const connection = await loadAmazonAdsConnectionById(job.connection_id);
    const accessToken = await getAmazonAdsAccessToken(job.connection_id);
    const updatedJob = await refreshAmazonAdsReportJobStatus({
      accessToken,
      region: connection.region,
      job
    });

    res.json({
      ok: true,
      job: {
        jobId: updatedJob.id,
        reportId: updatedJob.report_id,
        reportType: updatedJob.report_type,
        adProduct: updatedJob.ad_product,
        status: updatedJob.status,
        startDate: updatedJob.start_date,
        endDate: updatedJob.end_date,
        failureReason: updatedJob.failure_reason,
        requestedAt: updatedJob.requested_at,
        completedAt: updatedJob.completed_at
      }
    });
  } catch (error) {
    logger.warn("Amazon Ads report job status failed safely.", {
      jobId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads report job.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsDownloadCampaignReport(req: Request, res: Response): Promise<void> {
  const jobId = req.params.jobId;

  try {
    const job = await loadAmazonAdsReportJob(jobId);

    if (job.status.toUpperCase() !== "COMPLETED" || !job.report_url) {
      res.json({
        ok: false,
        message: "Amazon Ads report is not ready yet.",
        jobId,
        status: job.status
      });
      return;
    }

    const syncedCount = await downloadAndSaveCampaignReport(job);

    res.json({
      ok: true,
      jobId,
      syncedCount
    });
  } catch (error) {
    logger.warn("Amazon Ads campaign report download failed safely.", {
      jobId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not download Amazon Ads campaign report.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsDownloadSearchTermReport(req: Request, res: Response): Promise<void> {
  const jobId = req.params.jobId;

  try {
    const job = await loadAmazonAdsReportJob(jobId);

    if (job.report_type !== "spSearchTerm") {
      sendBeginnerError(res, 400, "This report job is not a Sponsored Products search term report.");
      return;
    }

    if (job.status.toUpperCase() !== "COMPLETED" || !job.report_url) {
      res.json({
        ok: false,
        message: "Amazon Ads search term report is not ready yet.",
        jobId,
        status: job.status
      });
      return;
    }

    const syncedCount = await downloadAndSaveSearchTermReport(job);

    res.json({
      ok: true,
      jobId,
      syncedCount
    });
  } catch (error) {
    logger.warn("Amazon Ads search term report download failed safely.", {
      jobId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not download Amazon Ads search term report.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsCampaignDailyMetrics(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const date = typeof req.query.date === "string" && req.query.date.trim()
      ? dateQuerySchema.parse(req.query.date.trim())
      : undefined;
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const result = await listCampaignDailyMetrics({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      date
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      date: result.date,
      metrics: result.metrics
    });
  } catch (error) {
    logger.warn("Amazon Ads campaign daily metrics request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads campaign daily metrics.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsSearchTermDailyMetrics(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const date = typeof req.query.date === "string" && req.query.date.trim()
      ? dateQuerySchema.parse(req.query.date.trim())
      : undefined;
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const result = await listSearchTermDailyMetrics({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      date
    });

    res.json({
      ok: true,
      sellerId,
      profileId: context.profile.profile_id,
      date: result.date,
      metrics: result.metrics
    });
  } catch (error) {
    logger.warn("Amazon Ads search term daily metrics request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads search term daily metrics.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsBackfillSearchTermReports(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const days = getDaysFromQuery(req);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const reportSellerId = context.connection.seller_id ?? sellerId;
    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const jobs: Array<{ date: string; jobId: string; reportId: string; status: string }> = [];
    let skippedCount = 0;

    for (let offset = 1; offset <= days; offset += 1) {
      const date = getBackfillDate(offset);
      const metricsExist = await hasSearchTermMetricsForDate({
        connectionId: context.connection.id,
        profileId: context.profile.profile_id,
        sellerId: reportSellerId,
        date
      });

      if (metricsExist) {
        skippedCount += 1;
        continue;
      }

      const jobExists = await hasSearchTermReportJobForDate({
        connectionId: context.connection.id,
        profileId: context.profile.profile_id,
        sellerId: reportSellerId,
        date
      });

      if (jobExists) {
        skippedCount += 1;
        continue;
      }

      const job = await requestSponsoredProductsSearchTermReport({
        accessToken,
        region: context.connection.region,
        profileId: context.profile.profile_id,
        connectionId: context.connection.id,
        sellerId: reportSellerId,
        date
      });

      jobs.push({
        date,
        jobId: job.jobId,
        reportId: job.reportId,
        status: job.status
      });
    }

    res.json({
      ok: true,
      sellerId,
      requestedCount: jobs.length,
      skippedCount,
      jobs
    });
  } catch (error) {
    logger.warn("Amazon Ads search term report backfill failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not backfill Amazon Ads search term reports.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsProcessSearchTermReportJobs(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 5;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 5, 1), 50);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const processed = await processAmazonAdsSearchTermReportJobsForContext({
      context,
      sellerId,
      limit
    });

    res.json({
      ok: true,
      sellerId,
      ...processed
    });
  } catch (error) {
    logger.warn("Amazon Ads search term report job processing failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not process Amazon Ads search term report jobs.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsSearchTermSummary(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const days = getSummaryDaysFromQuery(req);
    const summary = await getSearchTermSummary({
      sellerId,
      days
    });

    res.json({
      ok: true,
      sellerId,
      days,
      ...summary
    });
  } catch (error) {
    logger.warn("Amazon Ads search term summary request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads search term summary.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsPpcRecommendations(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const days = getSummaryDaysFromQuery(req);
    const targetAcos = getTargetAcosFromQuery(req);
    const recommendations = await buildAmazonAdsPpcRecommendations({
      sellerId,
      days,
      targetAcos
    });

    if (shouldSaveRecommendations(req)) {
      const dateRange = getAmazonAdsPpcRecommendationDateRange(days);
      const saveResult = await saveAmazonAdsPpcRecommendations({
        sellerId,
        recommendations,
        dataStartDate: dateRange.startDate,
        dataEndDate: dateRange.endDate
      });
      const ledgerSync = await syncRecommendationsToActionLedger({ sellerId }).catch((error) => {
        logger.warn("PPC recommendation bridge to action ledger failed safely.", {
          sellerId,
          message: getSafeAmazonAdsUnknownErrorMessage(error)
        });
        return null;
      });

      res.json({
        ...recommendations,
        savedCount: saveResult.savedCount,
        skippedDuplicateCount: saveResult.skippedDuplicateCount,
        actionLedgerCreatedCount: ledgerSync?.createdCount ?? 0,
        actionLedgerExistingCount: ledgerSync?.existingCount ?? 0
      });
      return;
    }

    res.json(recommendations);
  } catch (error) {
    logger.warn("Amazon Ads PPC recommendations request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads PPC recommendations.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsBackfillCampaignReports(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const days = getDaysFromQuery(req);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const reportSellerId = context.connection.seller_id ?? sellerId;
    const accessToken = await getAmazonAdsAccessToken(context.connection.id);
    const jobs: Array<{ date: string; jobId: string; reportId: string; status: string }> = [];
    let skippedCount = 0;

    for (let offset = 1; offset <= days; offset += 1) {
      const date = getBackfillDate(offset);
      const metricsExist = await hasCampaignMetricsForDate({
        connectionId: context.connection.id,
        profileId: context.profile.profile_id,
        sellerId: reportSellerId,
        date
      });

      if (metricsExist) {
        skippedCount += 1;
        continue;
      }

      const jobExists = await hasActiveCampaignReportJobForDate({
        connectionId: context.connection.id,
        profileId: context.profile.profile_id,
        sellerId: reportSellerId,
        date
      });

      if (jobExists) {
        skippedCount += 1;
        continue;
      }

      const job = await requestSponsoredProductsCampaignReport({
        accessToken,
        region: context.connection.region,
        profileId: context.profile.profile_id,
        connectionId: context.connection.id,
        sellerId: reportSellerId,
        date
      });

      jobs.push({
        date,
        jobId: job.jobId,
        reportId: job.reportId,
        status: job.status
      });
    }

    res.json({
      ok: true,
      sellerId,
      requestedCount: jobs.length,
      skippedCount,
      jobs
    });
  } catch (error) {
    logger.warn("Amazon Ads campaign report backfill failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not backfill Amazon Ads campaign reports.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsProcessCampaignReportJobs(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const limit = getLimitFromQuery(req);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const processed = await processAmazonAdsCampaignReportJobsForContext({
      context,
      sellerId,
      limit
    });

    res.json({
      ok: true,
      sellerId,
      ...processed
    });
  } catch (error) {
    logger.warn("Amazon Ads report job processing failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not process Amazon Ads campaign report jobs.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsDailyCampaignSync(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  if (!env.CRON_SECRET) {
    res.status(500).json({
      ok: false,
      message: "Daily campaign sync is not configured."
    });
    return;
  }

  if (!hasValidCronSecret(req)) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized."
    });
    return;
  }

  try {
    const yesterday = getYesterdayDate();
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const processed = await processAmazonAdsCampaignReportJobsForContext({
      context,
      sellerId,
      limit: 3
    });
    const reportSellerId = context.connection.seller_id ?? sellerId;
    const alreadyHadMetrics = await hasCampaignMetricsForDate({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      sellerId: reportSellerId,
      date: yesterday
    });
    const alreadyHadJob = await hasCampaignReportJobForDate({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      sellerId: reportSellerId,
      date: yesterday
    });
    const yesterdayReport: {
      alreadyHadMetrics: boolean;
      alreadyHadJob: boolean;
      requested: boolean;
      jobId: string | null;
      reportId: string | null;
      status: string | null;
    } = {
      alreadyHadMetrics,
      alreadyHadJob,
      requested: false,
      jobId: null,
      reportId: null,
      status: null
    };

    if (!alreadyHadMetrics && !alreadyHadJob) {
      const accessToken = await getAmazonAdsAccessToken(context.connection.id);
      const job = await requestSponsoredProductsCampaignReport({
        accessToken,
        region: context.connection.region,
        profileId: context.profile.profile_id,
        connectionId: context.connection.id,
        sellerId: reportSellerId,
        date: yesterday
      });

      yesterdayReport.requested = true;
      yesterdayReport.jobId = job.jobId;
      yesterdayReport.reportId = job.reportId;
      yesterdayReport.status = job.status;
    }

    res.json({
      ok: true,
      sellerId,
      yesterday,
      processed: {
        checkedCount: processed.checkedCount,
        syncedCount: processed.syncedCount,
        pendingCount: processed.pendingCount,
        failedCount: processed.failedCount
      },
      yesterdayReport
    });
  } catch (error) {
    logger.warn("Amazon Ads daily campaign sync failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not run Amazon Ads daily campaign sync.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function getAmazonAdsDashboardSummary(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const days = getDaysFromQuery(req);
    const context = await loadAmazonAdsCampaignContext(sellerId);

    if (!context.ok) {
      if (context.database) {
        sendDatabaseFailure(res, context.message);
        return;
      }
      sendBeginnerError(res, context.status, context.message);
      return;
    }

    const summary = await getCampaignDashboardSummary({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      sellerId: context.connection.seller_id ?? sellerId,
      days
    });

    res.json({
      ok: true,
      sellerId,
      days,
      ...summary
    });
  } catch (error) {
    logger.warn("Amazon Ads dashboard summary request failed safely.", {
      sellerId,
      message: getSafeAmazonAdsUnknownErrorMessage(error)
    });

    res.status(400).json({
      ok: false,
      message: "Could not load Amazon Ads dashboard summary.",
      details: getSafeAmazonAdsUnknownErrorMessage(error)
    });
  }
}

export async function postAmazonAdsTestConnection(req: Request, res: Response): Promise<void> {
  const body = sellerQuerySchema.safeParse(req.body);

  if (!body.success) {
    sendBeginnerError(res, 400, "sellerId is required to test Amazon Ads connection.");
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(body.data.sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  if (!lookup.connection || lookup.connection.status !== "connected") {
    sendBeginnerError(res, 404, "No connected Amazon Ads account found for this sellerId.");
    return;
  }

  const accessToken = await getAmazonAdsAccessToken(lookup.connection.id);
  const profiles = await getAmazonAdsProfiles(accessToken, lookup.connection.region, lookup.connection.id);
  await saveAmazonAdsProfiles(lookup.connection.id, profiles);

  res.json({
    ok: true,
    message: "Amazon Ads connection test completed.",
    profilesFound: profiles.length
  });
}

export async function postAmazonAdsDisconnect(req: Request, res: Response): Promise<void> {
  const body = sellerQuerySchema.safeParse(req.body);

  if (!body.success) {
    sendBeginnerError(res, 400, "sellerId is required to disconnect Amazon Ads.");
    return;
  }

  const lookup = await findAmazonAdsConnectionBySellerId(body.data.sellerId);

  if (!lookup.ok) {
    sendDatabaseFailure(res);
    return;
  }

  if (!lookup.connection) {
    sendBeginnerError(res, 404, "No Amazon Ads connection found for this sellerId.");
    return;
  }

  await deleteAmazonAdsTokens(lookup.connection.id);

  const { error } = await supabase
    .from("amazon_ads_connections")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", lookup.connection.id);

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not disconnect Amazon Ads.", error);
    sendDatabaseFailure(res, "Could not disconnect Amazon Ads in Supabase.");
    return;
  }

  res.json({
    ok: true,
    message: "Amazon Ads account disconnected."
  });
}

export async function getAmazonAdsDbHealth(_req: Request, res: Response): Promise<void> {
  const tableNames = [
    "amazon_ads_connections",
    "amazon_ads_tokens",
    "amazon_ads_profiles",
    "amazon_ads_api_logs"
  ] as const;

  const tables: Record<(typeof tableNames)[number], boolean> = {
    amazon_ads_connections: false,
    amazon_ads_tokens: false,
    amazon_ads_profiles: false,
    amazon_ads_api_logs: false
  };

  for (const tableName of tableNames) {
    try {
      const { error } = await supabase.from(tableName).select("id", {
        count: "exact",
        head: true
      });

      if (error) {
        logSafeAmazonAdsSupabaseError(`Amazon Ads db-health failed for ${tableName}.`, error);
        tables[tableName] = false;
        continue;
      }

      tables[tableName] = true;
    } catch (error) {
      logger.warn(`Amazon Ads db-health could not reach ${tableName}.`, {
        message: getSafeAmazonAdsUnknownErrorMessage(error)
      });
      tables[tableName] = false;
    }
  }

  const ok = Object.values(tables).every(Boolean);

  res.status(ok ? 200 : 503).json({
    ok,
    tables
  });
}
