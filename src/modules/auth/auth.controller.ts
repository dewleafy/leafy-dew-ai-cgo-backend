import { Request, Response } from "express";
import { AuthLoginResponse, AuthStatusResponse } from "./auth.types";
import {
  clearFailedLogins,
  isAuthEnabled,
  isLoginBlocked,
  issueToken,
  readBearerToken,
  recordFailedLogin,
  verifyPassword,
  verifyToken
} from "./auth.service";

function clientKey(req: Request): string {
  const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

export async function getAuthStatusRoute(req: Request, res: Response): Promise<void> {
  const enabled = isAuthEnabled();
  const body: AuthStatusResponse = {
    ok: true,
    enabled,
    authenticated: !enabled || verifyToken(readBearerToken(req.header("authorization")))
  };
  res.json(body);
}

export async function postAuthLoginRoute(req: Request, res: Response): Promise<void> {
  if (!isAuthEnabled()) {
    const body: AuthLoginResponse = { ok: true, enabled: false };
    res.json(body);
    return;
  }

  const key = clientKey(req);
  const waitSeconds = isLoginBlocked(key);
  if (waitSeconds > 0) {
    res.setHeader("Retry-After", String(waitSeconds));
    res.status(429).json({
      ok: false,
      message: `Too many wrong passwords. Try again in ${Math.ceil(waitSeconds / 60)} minute(s).`
    });
    return;
  }

  const password = (req.body as { password?: unknown } | undefined)?.password;
  if (!verifyPassword(password)) {
    recordFailedLogin(key);
    res.status(401).json({ ok: false, message: "Incorrect password." });
    return;
  }

  clearFailedLogins(key);
  const { token, expiresAt } = issueToken();
  const body: AuthLoginResponse = { ok: true, enabled: true, token, expiresAt };
  res.json(body);
}
