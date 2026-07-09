import express, { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "./config/env";
import { supabase } from "./db/supabase";
import { actionLedgerRoutes } from "./modules/action-ledger/action-ledger.routes";
import { activityLogRoutes } from "./modules/activity-logs/activity-logs.routes";
import { amazonAdsRouter } from "./modules/amazon-ads/amazon-ads.routes";
import { amazonSpRouter } from "./modules/amazon-sp/amazon-sp.routes";
import { amazonRouter } from "./modules/amazon/amazon.routes";
import { automationSettingsRoutes } from "./modules/automation-settings/automation-settings.routes";
import { brandReadinessRoutes } from "./modules/brand-readiness/brand-readiness.routes";
import { ceoReportRouter } from "./modules/ceo-report/ceo-report.routes";
import { creativeRecommendationsRouter } from "./modules/creative-recommendations/creative-recommendations.routes";
import { dailyOrchestratorRouter } from "./modules/daily-orchestrator/daily-orchestrator.routes";
import { engineRegistryRouter } from "./modules/engine-registry/engine-registry.routes";
import { engineRouterRouter } from "./modules/engine-router/engine-router.routes";
import { executionGatewayRouter } from "./modules/execution-gateway/execution-gateway.routes";
import { experimentRoutes } from "./modules/experiments/experiments.routes";
import { learningLoopRouter } from "./modules/learning-loop/learning-loop.routes";
import { learningSummaryRoutes } from "./modules/learning-summary/learning-summary.routes";
import { listingDraftsRouter } from "./modules/listing-drafts/listing-drafts.routes";
import { listingReadinessRoutes } from "./modules/listing-readiness/listing-readiness.routes";
import { productEconomicsRouter } from "./modules/product-economics/product-economics.routes";
import { productPassportRoutes } from "./modules/product-passports/product-passports.routes";
import { recommendationOutcomeRoutes } from "./modules/recommendation-outcomes/recommendation-outcomes.routes";
import { recommendationsRouter } from "./modules/recommendations/recommendations.routes";
import { todayCommandRouter } from "./modules/today-command/today-command.routes";
import { logger } from "./utils/logger";

const app = express();
const port = Number(process.env.PORT) || 3000;
const allowedCorsOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:5174",
  "https://leafydew.in",
  "https://www.leafydew.in",
  "https://app.leafydew.in",
  "https://leafy-dew-ai-cgo-frontend.vercel.app",
]);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  if (origin && allowedCorsOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-cron-secret");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }

  next();
});

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
app.use("/api/amazon-sp", amazonSpRouter);
app.use("/api/action-ledger", actionLedgerRoutes);
app.use("/api/activity-logs", activityLogRoutes);
app.use("/api/automation-settings", automationSettingsRoutes);
app.use("/api/brand-readiness", brandReadinessRoutes);
app.use("/api/ceo-report", ceoReportRouter);
app.use("/api/creative-recommendations", creativeRecommendationsRouter);
app.use("/api/daily-orchestrator", dailyOrchestratorRouter);
app.use("/api/engine-registry", engineRegistryRouter);
app.use("/api/engine-router", engineRouterRouter);
app.use("/api/execution-gateway", executionGatewayRouter);
app.use("/api/experiments", experimentRoutes);
app.use("/api/learning-loop", learningLoopRouter);
app.use("/api/learning-summary", learningSummaryRoutes);
app.use("/api/listing-drafts", listingDraftsRouter);
app.use("/api/listing-readiness", listingReadinessRoutes);
app.use("/api/product-economics", productEconomicsRouter);
app.use("/api/product-passport", productPassportRoutes);
app.use("/api/product-passports", productPassportRoutes);
app.use("/api/recommendation-outcomes", recommendationOutcomeRoutes);
app.use("/api/recommendations", recommendationsRouter);
app.use("/api/today-command", todayCommandRouter);

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
