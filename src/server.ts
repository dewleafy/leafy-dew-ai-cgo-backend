import express, { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "./config/env";
import { supabase } from "./db/supabase";
import { amazonAdsRouter } from "./modules/amazon-ads/amazon-ads.routes";
import { amazonRouter } from "./modules/amazon/amazon.routes";
import { brandReadinessRoutes } from "./modules/brand-readiness/brand-readiness.routes";
import { ceoReportRouter } from "./modules/ceo-report/ceo-report.routes";
import { experimentRoutes } from "./modules/experiments/experiments.routes";
import { listingReadinessRoutes } from "./modules/listing-readiness/listing-readiness.routes";
import { productEconomicsRouter } from "./modules/product-economics/product-economics.routes";
import { productPassportRoutes } from "./modules/product-passports/product-passports.routes";
import { recommendationOutcomeRoutes } from "./modules/recommendation-outcomes/recommendation-outcomes.routes";
import { recommendationsRouter } from "./modules/recommendations/recommendations.routes";
import { logger } from "./utils/logger";

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

function getSupabaseKeyPrefix(key: string | undefined): "sb_secret" | "sb_publishable" | "jwt" | "other" | "missing" {
  if (!key) {
    return "missing";
  }

  if (key.startsWith("sb_secret")) {
    return "sb_secret";
  }

  if (key.startsWith("sb_publishable")) {
    return "sb_publishable";
  }

  if (key.split(".").length === 3) {
    return "jwt";
  }

  return "other";
}

function sanitizeDatabaseErrorMessage(message: string): string {
  return sanitizeErrorMessage(message);
}

function sanitizeErrorMessage(message: string): string {
  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.AMAZON_LWA_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_SECRET,
    env.ENCRYPTION_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (safeMessage, secretValue) => safeMessage.replaceAll(secretValue, "[REDACTED]"),
    message
  );
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "Leafy Dew AI-CGO backend",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/system/config-check", (_req: Request, res: Response) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  res.json({
    supabaseUrlPresent: Boolean(supabaseUrl),
    supabaseUrlLooksValid: Boolean(supabaseUrl && URL.canParse(supabaseUrl)),
    supabaseKeyPresent: Boolean(supabaseKey),
    supabaseKeyPrefix: getSupabaseKeyPrefix(supabaseKey),
    nodeEnv: env.NODE_ENV,
    port: String(port)
  });
});

app.get("/api/system/db-health", async (_req: Request, res: Response) => {
  try {
    const { count, error } = await supabase.from("amazon_connections").select("id", {
      count: "exact",
      head: true
    });

    if (error) {
      logger.warn("Supabase health check failed.", {
        message: sanitizeErrorMessage(error.message)
      });

      res.status(503).json({
        ok: false,
        error: "Database connection failed",
        message: sanitizeDatabaseErrorMessage(error.message)
      });
      return;
    }

    res.json({
      ok: true,
      database: "connected",
      amazonConnectionsCount: count ?? 0,
      message: "Backend can reach Supabase."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";

    logger.warn("Supabase health check could not reach the database.", {
      message: sanitizeErrorMessage(message)
    });

    res.status(503).json({
      ok: false,
      error: "Database connection failed",
      message: sanitizeDatabaseErrorMessage(message)
    });
  }
});

app.use("/api/amazon", amazonRouter);
app.use("/api/amazon-ads", amazonAdsRouter);
app.use("/api/brand-readiness", brandReadinessRoutes);
app.use("/api/ceo-report", ceoReportRouter);
app.use("/api/experiments", experimentRoutes);
app.use("/api/listing-readiness", listingReadinessRoutes);
app.use("/api/product-economics", productEconomicsRouter);
app.use("/api/product-passports", productPassportRoutes);
app.use("/api/recommendation-outcomes", recommendationOutcomeRoutes);
app.use("/api/recommendations", recommendationsRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: "Route not found." });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      message: "Validation error.",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
    return;
  }

  const message = sanitizeErrorMessage(
    error instanceof Error ? error.message : "Unexpected server error."
  );
  logger.error("Request failed.", { message });

  res.status(500).json({
    message
  });
});

app.listen(port, () => {
  logger.info(`Leafy Dew AI-CGO backend running on port ${port}`);
});
