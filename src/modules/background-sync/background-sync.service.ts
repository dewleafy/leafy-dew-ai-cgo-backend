import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { syncAmazonSpListingAttributes, syncAmazonSpListings } from "../amazon-sp/amazon-sp.service";
import { getFirstAmazonAdsProfile } from "../amazon-ads/amazon-ads-profile.service";
import { getAmazonAdsAccessToken } from "../amazon-ads/amazon-ads-token.service";
import { AmazonAdsConnection } from "../amazon-ads/amazon-ads.types";
import {
  downloadAndSaveAdvertisedProductReport,
  downloadAndSaveSearchTermReport,
  hasAdvertisedProductReportJobForDate,
  hasSearchTermReportJobForDate,
  listProcessableAdvertisedProductReportJobs,
  listProcessableSearchTermReportJobs,
  markAmazonAdsReportJobSynced,
  refreshAmazonAdsReportJobStatus,
  requestSponsoredProductsAdvertisedProductReport,
  requestSponsoredProductsSearchTermReport
} from "../amazon-ads/amazon-ads-report.service";
import { runDailyOrchestrator } from "../daily-orchestrator/daily-orchestrator.service";
import { generateAlerts } from "../alert-center/alert-center.service";

const DEFAULT_SELLER_ID = "default";
const INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const STARTUP_DELAY_MS = 30 * 1000; // wait for the server to finish booting first
const ATTRIBUTE_SYNC_BATCH_SIZE = 100;
const ATTRIBUTE_SYNC_MAX_BATCHES = 10; // safety ceiling; normal stop is one full pass

let lastRunAt: string | null = null;
let lastRunSummary: string | null = null;
let isRunning = false;

const pendingListingsReportIdBySeller = new Map<string, string>();

export function getBackgroundAmazonSyncStatus(): { lastRunAt: string | null; lastRunSummary: string | null; isRunning: boolean } {
  return { lastRunAt, lastRunSummary, isRunning };
}

async function runListingsDiscovery(sellerId: string): Promise<string> {
  try {
    // Reuse a report Amazon is still generating from a previous tick, instead of
    // requesting a brand-new one every 15 minutes (which meant a report that took
    // longer than ~60 seconds to generate would NEVER actually complete — this is
    // why new listings, including variation children, weren't being discovered).
    const pendingReportId = pendingListingsReportIdBySeller.get(sellerId);
    const result = await syncAmazonSpListings({ sellerId, reportId: pendingReportId });
    if ("status" in result && result.status === "PROCESSING") {
      if (result.reportId) pendingListingsReportIdBySeller.set(sellerId, result.reportId);
      return `Listings report still processing on Amazon's side (reportId ${result.reportId ?? "unknown"}) — will continue checking next run.`;
    }
    pendingListingsReportIdBySeller.delete(sellerId);
    const synced = "syncedCount" in result ? result.syncedCount : 0;
    const distinctSkus = "distinctSkuCount" in result ? result.distinctSkuCount : undefined;
    const newCount = "newProductsCount" in result ? result.newProductsCount : undefined;
    const updatedCount = "updatedProductsCount" in result ? result.updatedProductsCount : undefined;
    if (typeof newCount === "number" && typeof updatedCount === "number") {
      const distinctText = typeof distinctSkus === "number" ? ` (${distinctSkus} distinct SKUs)` : "";
      return `Listings: found ${synced} rows${distinctText}, ${newCount} new product(s) added, ${updatedCount} existing refreshed.`;
    }
    const upserted = "upsertedProductPassports" in result ? result.upsertedProductPassports : 0;
    return `Listings: found ${synced}, added/updated ${upserted}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Background listings sync failed.", { message });
    pendingListingsReportIdBySeller.delete(sellerId);
    return `Listings sync skipped this run (${message}).`;
  }
}

async function runAttributeSync(sellerId: string): Promise<string> {
  let totalChecked = 0;
  let totalUpdated = 0;
  let totalEligible: number | undefined;
  try {
    for (let batch = 1; batch <= ATTRIBUTE_SYNC_MAX_BATCHES; batch += 1) {
      const result = await syncAmazonSpListingAttributes({ sellerId, limit: ATTRIBUTE_SYNC_BATCH_SIZE });
      totalChecked += result.checked;
      totalUpdated += result.updatedCount;
      totalEligible = result.totalEligible;
      const reachedEndOfBatch = result.checked < ATTRIBUTE_SYNC_BATCH_SIZE;
      const coveredFullCatalog = typeof result.totalEligible === "number" && totalChecked >= result.totalEligible;
      if (reachedEndOfBatch || coveredFullCatalog) break;
    }
    const totalText = typeof totalEligible === "number" ? ` (your database actually has ${totalEligible} product passport rows total)` : "";
    return `Attributes: checked ${totalChecked}, updated ${totalUpdated}.${totalText}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Background attribute sync failed.", { message });
    return `Attribute sync skipped this run (${message}).`;
  }
}

// Amazon Ads search-term reports only get generated when someone asks for one —
// unlike campaign metrics, nothing was requesting them automatically, so the
// PPC recommendation engine's search-term data (and therefore the negative
// keyword/negative target recommendations built on it) went stale until
// someone manually triggered a sync. This finds (or requests) yesterday's
// search-term report once a day, and downloads+saves it the moment it's
// ready — checked every 15-minute tick so a completed report never sits
// around long enough for Amazon's download link to expire.
async function findConnectedAmazonAdsAccount(sellerId: string): Promise<AmazonAdsConnection | null> {
  let query = supabase
    .from("amazon_ads_connections")
    .select("*")
    .eq("status", "connected")
    .order("connected_at", { ascending: false })
    .limit(1);

  if (sellerId !== DEFAULT_SELLER_ID) {
    query = query.eq("seller_id", sellerId);
  }

  const { data, error } = await query.maybeSingle<AmazonAdsConnection>();

  if (error) {
    logger.warn("Background search term sync could not look up the Amazon Ads connection.", {
      message: error.message
    });
    return null;
  }

  return data;
}

function getSearchTermTargetDate(): string {
  // Amazon Ads metrics for "today" aren't final yet, so — same as the manual
  // request endpoint — we always sync yesterday's complete day.
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Amazon's report download link only stays valid for a limited time after a
// report completes. If a completed job's link has already gone stale (for
// example a job that finished before this automated sync existed, or one a
// previous tick could not get to in time), mark it failed instead of
// retrying it — and failing the same way — on every future tick forever.
async function markSearchTermReportJobFailed(jobId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("amazon_ads_report_jobs")
    .update({
      status: "FAILED",
      failure_reason: reason,
      completed_at: new Date().toISOString()
    })
    .eq("id", jobId);

  if (error) {
    logger.warn("Could not mark stale Amazon Ads search term report job as failed.", {
      jobId,
      message: error.message
    });
  }
}

async function runSearchTermSync(sellerId: string): Promise<string> {
  try {
    const connection = await findConnectedAmazonAdsAccount(sellerId);

    if (!connection) {
      return "Search terms: no connected Amazon Ads account, skipped.";
    }

    const profile = await getFirstAmazonAdsProfile(connection.id);

    if (!profile) {
      return "Search terms: no Amazon Ads profile found, skipped.";
    }

    const effectiveSellerId = connection.seller_id ?? sellerId;

    // First, finish any report already in flight so a report that just
    // completed gets downloaded within minutes, not hours.
    const pendingJobs = await listProcessableSearchTermReportJobs({
      connectionId: connection.id,
      profileId: profile.profile_id,
      sellerId: effectiveSellerId,
      limit: 5
    });

    if (pendingJobs.length > 0) {
      const accessToken = await getAmazonAdsAccessToken(connection.id);
      const results: string[] = [];

      for (const job of pendingJobs) {
        let currentJob = job;

        if (currentJob.status.toUpperCase() !== "COMPLETED") {
          currentJob = await refreshAmazonAdsReportJobStatus({
            accessToken,
            region: connection.region,
            job: currentJob
          });
        }

        if (currentJob.status.toUpperCase() === "COMPLETED" && currentJob.report_url) {
          try {
            const savedCount = await downloadAndSaveSearchTermReport(currentJob);
            await markAmazonAdsReportJobSynced(currentJob.id);
            results.push(`saved ${savedCount} row(s) for ${currentJob.start_date}`);
          } catch (downloadError) {
            // Most likely cause: the report finished a while ago and Amazon's
            // download link has since expired. Stop retrying this job and let
            // the next tick request a fresh report instead.
            const message = downloadError instanceof Error ? downloadError.message : "Unknown error";
            await markSearchTermReportJobFailed(currentJob.id, message);
            results.push(
              `could not download the report for ${currentJob.start_date} (link likely expired) — will request a fresh one next run`
            );
          }
        } else {
          results.push(`still ${currentJob.status} for ${currentJob.start_date}`);
        }
      }

      return `Search terms: ${results.join("; ")}.`;
    }

    // Nothing in flight — request one new report per day (per date), the
    // same way the manual "request-search-term-report" endpoint does, so
    // this needs no manual trigger going forward.
    const targetDate = getSearchTermTargetDate();
    const alreadyRequested = await hasSearchTermReportJobForDate({
      connectionId: connection.id,
      profileId: profile.profile_id,
      sellerId: effectiveSellerId,
      date: targetDate
    });

    if (alreadyRequested) {
      return `Search terms: already up to date for ${targetDate}.`;
    }

    const accessToken = await getAmazonAdsAccessToken(connection.id);
    await requestSponsoredProductsSearchTermReport({
      accessToken,
      region: connection.region,
      profileId: profile.profile_id,
      connectionId: connection.id,
      sellerId: effectiveSellerId,
      date: targetDate
    });

    return `Search terms: requested a new report for ${targetDate}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Background search term sync failed.", { message });
    return `Search term sync skipped this run (${message}).`;
  }
}

// Same reasoning and same fire-and-poll pattern as runSearchTermSync above,
// but for the "Advertised Product" report -- the only Amazon Ads report type
// that ties spend/sales to a specific ASIN/SKU. Nothing was pulling this
// report at all before, so there was no real per-product ad spend data for
// the order-economics module to blend into individual orders.
function getAdvertisedProductTargetDate(): string {
  // Same reasoning as search terms: "today" isn't final yet on Amazon's side,
  // so always sync yesterday's complete day.
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function markAdvertisedProductReportJobFailed(jobId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("amazon_ads_report_jobs")
    .update({
      status: "FAILED",
      failure_reason: reason,
      completed_at: new Date().toISOString()
    })
    .eq("id", jobId);

  if (error) {
    logger.warn("Could not mark stale Amazon Ads advertised product report job as failed.", {
      jobId,
      message: error.message
    });
  }
}

async function runAdvertisedProductSync(sellerId: string): Promise<string> {
  try {
    const connection = await findConnectedAmazonAdsAccount(sellerId);

    if (!connection) {
      return "Advertised product: no connected Amazon Ads account, skipped.";
    }

    const profile = await getFirstAmazonAdsProfile(connection.id);

    if (!profile) {
      return "Advertised product: no Amazon Ads profile found, skipped.";
    }

    const effectiveSellerId = connection.seller_id ?? sellerId;

    // First, finish any report already in flight so a report that just
    // completed gets downloaded within minutes, not hours.
    const pendingJobs = await listProcessableAdvertisedProductReportJobs({
      connectionId: connection.id,
      profileId: profile.profile_id,
      sellerId: effectiveSellerId,
      limit: 5
    });

    if (pendingJobs.length > 0) {
      const accessToken = await getAmazonAdsAccessToken(connection.id);
      const results: string[] = [];

      for (const job of pendingJobs) {
        let currentJob = job;

        if (currentJob.status.toUpperCase() !== "COMPLETED") {
          currentJob = await refreshAmazonAdsReportJobStatus({
            accessToken,
            region: connection.region,
            job: currentJob
          });
        }

        if (currentJob.status.toUpperCase() === "COMPLETED" && currentJob.report_url) {
          try {
            const savedCount = await downloadAndSaveAdvertisedProductReport(currentJob);
            await markAmazonAdsReportJobSynced(currentJob.id);
            results.push(`saved ${savedCount} row(s) for ${currentJob.start_date}`);
          } catch (downloadError) {
            // Most likely cause: the report finished a while ago and Amazon's
            // download link has since expired. Stop retrying this job and let
            // the next tick request a fresh report instead.
            const message = downloadError instanceof Error ? downloadError.message : "Unknown error";
            await markAdvertisedProductReportJobFailed(currentJob.id, message);
            results.push(
              `could not download the report for ${currentJob.start_date} (link likely expired) — will request a fresh one next run`
            );
          }
        } else {
          results.push(`still ${currentJob.status} for ${currentJob.start_date}`);
        }
      }

      return `Advertised product: ${results.join("; ")}.`;
    }

    // Nothing in flight — request one new report per day (per date), fully
    // automatic like every other background sync in this app.
    const targetDate = getAdvertisedProductTargetDate();
    const alreadyRequested = await hasAdvertisedProductReportJobForDate({
      connectionId: connection.id,
      profileId: profile.profile_id,
      sellerId: effectiveSellerId,
      date: targetDate
    });

    if (alreadyRequested) {
      return `Advertised product: already up to date for ${targetDate}.`;
    }

    const accessToken = await getAmazonAdsAccessToken(connection.id);
    await requestSponsoredProductsAdvertisedProductReport({
      accessToken,
      region: connection.region,
      profileId: profile.profile_id,
      connectionId: connection.id,
      sellerId: effectiveSellerId,
      date: targetDate
    });

    return `Advertised product: requested a new report for ${targetDate}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Background advertised product sync failed.", { message });
    return `Advertised product sync skipped this run (${message}).`;
  }
}

// The Daily AI-CGO orchestrator (300-engine registry + Alert Center) previously only ever
// ran when someone opened Advanced Tools -> Automation -> "Daily AI Run" and clicked the
// button themselves -- so it had gone quiet for weeks even though it was fully built and
// safe (shadow mode, approval-first, no external execution). This makes it self-driving,
// the same way every other sync in this file already is: checked every 15-minute tick, but
// gated so the actual (heavier) engine run only fires roughly once a day, not 96 times.
const DAILY_ORCHESTRATOR_MIN_GAP_MS = 20 * 60 * 60 * 1000;

async function hasRecentScheduledOrchestratorRun(sellerId: string): Promise<boolean> {
  const since = new Date(Date.now() - DAILY_ORCHESTRATOR_MIN_GAP_MS).toISOString();
  const { data, error } = await supabase
    .from("daily_orchestrator_runs")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("run_type", "CRON")
    .gte("started_at", since)
    .limit(1);

  if (error) {
    logger.warn("Could not check for a recent scheduled Daily AI-CGO run.", { message: error.message });
    // Fail safe on a read error: assume one already ran, so a transient DB hiccup can never
    // cause the orchestrator to fire on every single 15-minute tick back-to-back.
    return true;
  }

  return (data ?? []).length > 0;
}

async function runScheduledDailyOrchestration(sellerId: string): Promise<string> {
  try {
    const alreadyRanRecently = await hasRecentScheduledOrchestratorRun(sellerId);
    if (alreadyRanRecently) {
      return "Daily AI-CGO: already ran in the last 20 hours, skipped.";
    }

    const result = await runDailyOrchestrator({
      sellerId,
      actor: "scheduler",
      limit: 25,
      categories: [],
      runType: "CRON"
    });

    // Refresh the Alert Center right after, so anything the engine run just found (or any
    // other change since the last check -- pending approvals, ACOS, cost-data gaps, etc.)
    // is reflected before the founder next opens the Today page. generateAlerts() is
    // idempotent -- it skips any rule that already has a matching open alert -- so calling
    // it daily is safe and never creates duplicates.
    const alertResult = await generateAlerts(sellerId).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn("Automatic Alert Center refresh after scheduled Daily AI-CGO run failed.", { message });
      return null;
    });
    const alertText = alertResult ? ` Alert Center: ${alertResult.generatedCount} new alert(s).` : "";

    return `Daily AI-CGO: ran ${result.enginesRun} engines, created ${result.actionsCreated} new recommendation(s), shadow mode only (no Amazon/Ads action taken).${alertText}`;
  } catch (error) {
    // runDailyOrchestrator already fails safely (shadow mode, no external action) on its own
    // internal errors -- this catch is only for something unexpected escaping that, and must
    // never take down the rest of this 15-minute sync tick.
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Scheduled Daily AI-CGO run failed.", { message });
    return `Daily AI-CGO run skipped this tick (${message}).`;
  }
}

async function runBackgroundAmazonSync(sellerId: string = DEFAULT_SELLER_ID): Promise<void> {
  if (isRunning) {
    logger.info("Background Amazon sync already running, skipping this tick.");
    return;
  }
  isRunning = true;
  try {
    const listingsSummary = await runListingsDiscovery(sellerId);
    const attributesSummary = await runAttributeSync(sellerId);
    const searchTermSummary = await runSearchTermSync(sellerId);
    const advertisedProductSummary = await runAdvertisedProductSync(sellerId);
    const dailyOrchestratorSummary = await runScheduledDailyOrchestration(sellerId);
    lastRunAt = new Date().toISOString();
    lastRunSummary = `${listingsSummary} ${attributesSummary} ${searchTermSummary} ${advertisedProductSummary} ${dailyOrchestratorSummary}`;
    logger.info("Background Amazon sync completed.", { summary: lastRunSummary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    lastRunAt = new Date().toISOString();
    lastRunSummary = `Background sync failed: ${message}`;
    logger.error("Background Amazon sync failed.", { message });
  } finally {
    isRunning = false;
  }
}

export function startBackgroundAmazonSyncScheduler(): void {
  logger.info(`Background Amazon sync scheduler starting — runs every ${INTERVAL_MS / 60000} minutes.`);
  setTimeout(() => {
    void runBackgroundAmazonSync();
    setInterval(() => {
      void runBackgroundAmazonSync();
    }, INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
