import { logger } from "../../utils/logger";
import { syncAmazonSpListingAttributes, syncAmazonSpListings } from "../amazon-sp/amazon-sp.service";

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
    const newCount = "newProductsCount" in result ? result.newProductsCount : undefined;
    const updatedCount = "updatedProductsCount" in result ? result.updatedProductsCount : undefined;
    if (typeof newCount === "number" && typeof updatedCount === "number") {
      return `Listings: found ${synced} on Amazon, ${newCount} new product(s) added, ${updatedCount} existing refreshed.`;
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

  try {
    for (let batch = 1; batch <= ATTRIBUTE_SYNC_MAX_BATCHES; batch += 1) {
      const result = await syncAmazonSpListingAttributes({ sellerId, limit: ATTRIBUTE_SYNC_BATCH_SIZE });
      totalChecked += result.checked;
      totalUpdated += result.updatedCount;

      const reachedEndOfBatch = result.checked < ATTRIBUTE_SYNC_BATCH_SIZE;
      const coveredFullCatalog = typeof result.totalEligible === "number" && totalChecked >= result.totalEligible;
      if (reachedEndOfBatch || coveredFullCatalog) break;
    }
    return `Attributes: checked ${totalChecked}, updated ${totalUpdated}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Background attribute sync failed.", { message });
    return `Attribute sync skipped this run (${message}).`;
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

    lastRunAt = new Date().toISOString();
    lastRunSummary = `${listingsSummary} ${attributesSummary}`;
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
