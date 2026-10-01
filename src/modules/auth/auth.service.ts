import crypto from "crypto";
import { env } from "../../config/env";

// Single-owner login. Login is OFF until APP_PASSWORD is set in the server environment,
// so deploying this code can never lock the founder out by itself.
//
// Tokens are stateless: base64url(payload) + "." + base64url(HMAC-SHA256(payload)).
// The signing key mixes AUTH_SECRET (optional) with APP_PASSWORD, so changing the
// password signs everyone out.

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function isAuthEnabled(): boolean {
  return Boolean(env.APP_PASSWORD && env.APP_PASSWORD.length > 0);
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

/** Constant-time string comparison (hashes first so length differences leak nothing). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function signingKey(): Buffer {
  return sha256(`leafy-dew-auth:v1:${env.AUTH_SECRET ?? ""}:${env.APP_PASSWORD ?? ""}`);
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function sign(payload: string): string {
  return toBase64Url(crypto.createHmac("sha256", signingKey()).update(payload).digest());
}

export function verifyPassword(input: unknown): boolean {
  return isAuthEnabled() && typeof input === "string" && input.length > 0 && safeEqual(input, env.APP_PASSWORD as string);
}

export function issueToken(): { token: string; expiresAt: string } {
  const expiresAtMs = Date.now() + TOKEN_TTL_MS;
  const payload = toBase64Url(Buffer.from(JSON.stringify({ v: 1, exp: expiresAtMs })));
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function verifyToken(token: string | undefined): boolean {
  if (!isAuthEnabled() || !token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: number; exp?: number };
    return parsed.v === 1 && typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function readBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1];
}

// In-memory brute-force guard: after 5 wrong passwords an address must wait 15 minutes.
const failedLogins = new Map<string, { count: number; resetAt: number }>();

export function isLoginBlocked(clientKey: string): number {
  const entry = failedLogins.get(clientKey);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    failedLogins.delete(clientKey);
    return 0;
  }
  return entry.count >= MAX_FAILED_LOGINS ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
}

export function recordFailedLogin(clientKey: string): void {
  const now = Date.now();
  const entry = failedLogins.get(clientKey);
  if (!entry || entry.resetAt <= now) {
    failedLogins.set(clientKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function clearFailedLogins(clientKey: string): void {
  failedLogins.delete(clientKey);
}
