import { Request, Response } from "express";
import { env } from "../../config/env";
import {
  buildAmazonSpConnectUrl,
  createDailyAmazonSpSyncJobs,
  debugAmazonSpOrderReport,
  getAmazonSpConfigCheck,
  getAmazonSpSalesSummary,
  getAmazonSpStatus,
  handleAmazonSpOAuthCallback,
  listAmazonSpReportJobs,
  listAmazonSpListings,
  listAmazonSpOrders,
  processAmazonSpReportJobs,
  runAmazonSpDoctor,
  syncAmazonSpListings,
  syncAmazonSpOrderReport,
  syncAmazonSpOrderReportChunked,
  syncAmazonSpOrders
} from "./amazon-sp.service";
import { safeErrorDetails, safeErrorMessage } from "./amazon-sp-utils";

function getSellerId(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getLimit(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  return Math.min(Math.max(limit, 1), 200);
}

function getDays(req: Request, defaultDays = 7, maxDays = 90): number {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : defaultDays;
  const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : defaultDays;
  return Math.min(Math.max(days, 1), maxDays);
}

function getReportId(req: Request): string | undefined {
  return typeof req.query.reportId === "string" && req.query.reportId.trim()
    ? req.query.reportId.trim()
    : undefined;
}

function getReportTypeMode(req: Request): string | undefined {
  return typeof req.query.reportType === "string" && req.query.reportType.trim()
    ? req.query.reportType.trim().toUpperCase()
    : undefined;
}

function getJobLimit(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 5;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 5;
  return Math.min(Math.max(limit, 1), 20);
}

function requireCronSecret(req: Request, res: Response): boolean {
  if (!env.CRON_SECRET) {
    res.status(500).json({
      ok: false,
      message: "CRON_SECRET is not configured."
    });
    return false;
  }

  const headerSecret = req.header("x-cron-secret");
  if (headerSecret !== env.CRON_SECRET) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized."
    });
    return false;
  }

  return true;
}

function sendSafeError(res: Response, message: string, error: unknown): void {
  res.status(503).json({
    ok: false,
    message,
    details: safeErrorDetails(error)
  });
}

export async function getAmazonSpConfigCheckController(_req: Request, res: Response): Promise<void> {
  res.json(getAmazonSpConfigCheck());
}

export async function getAmazonSpConnectUrlController(req: Request, res: Response): Promise<void> {
  try {
    const result = buildAmazonSpConnectUrl(getSellerId(req));
    res.json(result);
  } catch (error) {
    sendSafeError(res, "Could not create Amazon Seller Central connection URL.", error);
  }
}

export async function getAmazonSpCallbackController(req: Request, res: Response): Promise<void> {
  const code = typeof req.query.spapi_oauth_code === "string"
    ? req.query.spapi_oauth_code
    : typeof req.query.code === "string"
      ? req.query.code
      : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const amazonSellerId = typeof req.query.selling_partner_id === "string" ? req.query.selling_partner_id : null;

  if (!code) {
    res.status(400).send("Amazon Seller Central authorization failed. Missing authorization code.");
    return;
  }

  try {
    const result = await handleAmazonSpOAuthCallback({
      code,
      state,
      amazonSellerId
    });

    res
      .status(200)
      .send(`Amazon Seller Central connected successfully for seller ${result.sellerId}. You can close this tab.`);
  } catch (error) {
    res
      .status(503)
      .send(`Amazon Seller Central authorization failed. ${safeErrorMessage(error)}`);
  }
}

export async function getAmazonSpStatusController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getAmazonSpStatus(getSellerId(req)));
  } catch (error) {
    sendSafeError(res, "Could not load Amazon SP-API status.", error);
  }
}

export async function getAmazonSpDoctorController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await runAmazonSpDoctor(getSellerId(req)));
  } catch (error) {
    sendSafeError(res, "Could not run Amazon SP-API doctor.", error);
  }
}

export async function syncAmazonSpListingsController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await syncAmazonSpListings({
      sellerId: getSellerId(req),
      reportId: getReportId(req)
    }));
  } catch (error) {
    sendSafeError(res, "Could not sync Amazon SP-API listings.", error);
  }
}

export async function listAmazonSpListingsController(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listAmazonSpListings(getSellerId(req), getLimit(req));
    res.json({
      ok: true,
      sellerId: getSellerId(req),
      count: rows.length,
      rows
    });
  } catch (error) {
    sendSafeError(res, "Could not load Amazon SP-API listings.", error);
  }
}

export async function syncAmazonSpOrdersController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await syncAmazonSpOrders(getSellerId(req), getDays(req, 7, 30)));
  } catch (error) {
    sendSafeError(res, "Could not sync Amazon SP-API orders.", error);
  }
}

export async function syncAmazonSpOrderReportController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await syncAmazonSpOrderReport({
      sellerId: getSellerId(req),
      days: getDays(req, 30, 90),
      reportId: getReportId(req)
    }));
  } catch (error) {
    sendSafeError(res, "Could not sync Amazon SP-API order report.", error);
  }
}

export async function syncAmazonSpOrderReportChunkedController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await syncAmazonSpOrderReportChunked({
      sellerId: getSellerId(req),
      days: getDays(req, 90, 90)
    }));
  } catch (error) {
    sendSafeError(res, "Could not create chunked Amazon SP-API order reports.", error);
  }
}

export async function debugAmazonSpOrderReportController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await debugAmazonSpOrderReport({
      sellerId: getSellerId(req),
      days: getDays(req, 30, 90),
      reportId: getReportId(req),
      reportTypeMode: getReportTypeMode(req)
    }));
  } catch (error) {
    sendSafeError(res, "Could not debug Amazon SP-API order report.", error);
  }
}

export async function dailyAmazonSpSyncController(req: Request, res: Response): Promise<void> {
  if (!requireCronSecret(req, res)) return;

  try {
    res.json(await createDailyAmazonSpSyncJobs(getSellerId(req)));
  } catch (error) {
    sendSafeError(res, "Could not create Amazon SP-API daily sync jobs.", error);
  }
}

export async function processAmazonSpReportJobsController(req: Request, res: Response): Promise<void> {
  if (!requireCronSecret(req, res)) return;

  try {
    res.json(await processAmazonSpReportJobs({
      sellerId: getSellerId(req),
      limit: getJobLimit(req)
    }));
  } catch (error) {
    sendSafeError(res, "Could not process Amazon SP-API report jobs.", error);
  }
}

export async function listAmazonSpReportJobsController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await listAmazonSpReportJobs(getSellerId(req)));
  } catch (error) {
    sendSafeError(res, "Could not load Amazon SP-API report jobs.", error);
  }
}

export async function listAmazonSpOrdersController(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listAmazonSpOrders(getSellerId(req), getDays(req));
    res.json({
      ok: true,
      sellerId: getSellerId(req),
      days: getDays(req),
      count: rows.length,
      rows
    });
  } catch (error) {
    sendSafeError(res, "Could not load Amazon SP-API orders.", error);
  }
}

export async function getAmazonSpSalesSummaryController(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getAmazonSpSalesSummary(getSellerId(req), getDays(req)));
  } catch (error) {
    sendSafeError(res, "Could not load Amazon SP-API sales summary.", error);
  }
}
