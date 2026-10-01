import { NextFunction, Request, Response } from "express";
import { env } from "../../config/env";
import { isAuthEnabled, readBearerToken, safeEqual, verifyToken } from "./auth.service";

// Amazon redirects the founder's browser to these URLs after authorizing the app. The
// browser cannot attach a login token to a redirect, so they stay reachable (they were
// already reachable before login existed, and the exchange itself needs Amazon's code).
// Paths are relative to the "/api" mount point.
const PUBLIC_GET_PATHS = new Set(["/amazon/callback", "/amazon-sp/callback", "/amazon-ads/callback"]);

/**
 * Requires a valid login token on every /api route, except:
 *  - login being switched off (APP_PASSWORD not set),
 *  - CORS preflight,
 *  - the Amazon OAuth callbacks above,
 *  - automation calls that present the correct x-cron-secret header (those routes also
 *    check the secret themselves).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled() || req.method === "OPTIONS") {
    next();
    return;
  }

  if (req.method === "GET" && PUBLIC_GET_PATHS.has(req.path)) {
    next();
    return;
  }

  const cronSecret = req.header("x-cron-secret");
  if (env.CRON_SECRET && cronSecret && safeEqual(cronSecret, env.CRON_SECRET)) {
    next();
    return;
  }

  if (verifyToken(readBearerToken(req.header("authorization")))) {
    next();
    return;
  }

  res.status(401).json({ ok: false, code: "AUTH_REQUIRED", message: "Please sign in to continue." });
}
