import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { getOrderEconomics } from "./order-economics.service";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must use YYYY-MM-DD format");

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDaysFromQuery(req: Request): number {
  const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 7;
  const days = Number.isFinite(rawDays) ? Math.floor(rawDays) : 7;
  return Math.min(Math.max(days, 1), 31);
}

// Accepts either an explicit startDate/endDate (both YYYY-MM-DD) or a
// "days" window ending yesterday (Amazon's own report data always lags a
// day, same convention as the ad-spend reports this reuses).
function getDateRangeFromQuery(req: Request): { startDate: string; endDate: string } {
  const rawStart = typeof req.query.startDate === "string" ? req.query.startDate.trim() : "";
  const rawEnd = typeof req.query.endDate === "string" ? req.query.endDate.trim() : "";

  if (rawStart && rawEnd) {
    return {
      startDate: dateSchema.parse(rawStart),
      endDate: dateSchema.parse(rawEnd)
    };
  }

  const days = getDaysFromQuery(req);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(yesterday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  return {
    startDate: toDateOnly(start),
    endDate: toDateOnly(yesterday)
  };
}

function getSafeOrderEconomicsErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? "Could not load order-level profit/loss. Check that Amazon orders and ad-spend data have synced."
    : "Could not load order-level profit/loss.";
}

export async function getOrderEconomicsSummary(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);

  try {
    const { startDate, endDate } = getDateRangeFromQuery(req);
    const result = await getOrderEconomics({ sellerId, startDate, endDate });

    res.json({
      ok: true,
      sellerId,
      ...result
    });
  } catch (error) {
    logger.warn("Order economics request failed safely.", {
      sellerId,
      message: error instanceof Error ? error.message : "Unknown order economics error"
    });

    res.status(400).json({
      ok: false,
      message: "Could not load order-level profit/loss.",
      details: getSafeOrderEconomicsErrorMessage(error)
    });
  }
}
