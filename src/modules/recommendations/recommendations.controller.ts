import { Request, Response } from "express";
import { z } from "zod";
import {
  getAiRecommendationById,
  isAllowedRecommendationStatus,
  listAiRecommendations,
  updateAiRecommendationStatus
} from "./recommendations.service";
import { AiRecommendationStatus } from "./recommendations.types";

const statusBodySchema = z.object({
  userNote: z
    .string()
    .optional()
    .nullable()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    })
});

function getSellerIdFromQuery(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim()
    ? req.query.sellerId.trim()
    : "default";
}

function getStatusFromQuery(req: Request): string | undefined {
  return typeof req.query.status === "string" && req.query.status.trim()
    ? req.query.status.trim()
    : undefined;
}

function getLimitFromQuery(req: Request): number {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;

  return Math.min(Math.max(limit, 1), 500);
}

export async function getRecommendations(req: Request, res: Response): Promise<void> {
  const sellerId = getSellerIdFromQuery(req);
  const status = getStatusFromQuery(req);
  let validatedStatus: AiRecommendationStatus | undefined;

  if (status && !isAllowedRecommendationStatus(status)) {
    res.status(400).json({
      ok: false,
      message: "Invalid recommendation status."
    });
    return;
  }

  if (status) {
    validatedStatus = status as AiRecommendationStatus;
  }

  try {
    const rows = await listAiRecommendations({
      sellerId,
      status: validatedStatus,
      limit: getLimitFromQuery(req)
    });

    res.json({
      ok: true,
      sellerId,
      rows
    });
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not load recommendations from Supabase.",
      safeHint: "Run ai_recommendations.sql in Supabase and check the service role key."
    });
  }
}

export async function getRecommendationById(req: Request, res: Response): Promise<void> {
  try {
    const row = await getAiRecommendationById(req.params.id);

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Recommendation was not found."
      });
      return;
    }

    res.json({
      ok: true,
      row
    });
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not load recommendation from Supabase.",
      safeHint: "Run ai_recommendations.sql in Supabase and check the service role key."
    });
  }
}

async function updateRecommendationStatusFromRequest(
  req: Request,
  res: Response,
  status: AiRecommendationStatus,
  message: string
): Promise<void> {
  const body = statusBodySchema.safeParse(req.body ?? {});

  if (!body.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the recommendation note."
    });
    return;
  }

  try {
    const row = await updateAiRecommendationStatus({
      id: req.params.id,
      status,
      userNote: body.data.userNote
    });

    if (!row) {
      res.status(404).json({
        ok: false,
        message: "Recommendation was not found."
      });
      return;
    }

    res.json({
      ok: true,
      message,
      row
    });
  } catch {
    res.status(503).json({
      ok: false,
      message: "Could not update recommendation in Supabase.",
      safeHint: "Run ai_recommendations.sql in Supabase and check the service role key."
    });
  }
}

export async function approveRecommendation(req: Request, res: Response): Promise<void> {
  await updateRecommendationStatusFromRequest(
    req,
    res,
    "APPROVED",
    "Recommendation approved in shadow mode. No Amazon action was executed."
  );
}

export async function rejectRecommendation(req: Request, res: Response): Promise<void> {
  await updateRecommendationStatusFromRequest(
    req,
    res,
    "REJECTED",
    "Recommendation rejected. No Amazon action was executed."
  );
}

export async function monitorRecommendation(req: Request, res: Response): Promise<void> {
  await updateRecommendationStatusFromRequest(
    req,
    res,
    "MONITORING",
    "Recommendation moved to monitoring. No Amazon action was executed."
  );
}

export async function completeRecommendation(req: Request, res: Response): Promise<void> {
  await updateRecommendationStatusFromRequest(
    req,
    res,
    "COMPLETED_MANUALLY",
    "Recommendation marked completed manually."
  );
}
