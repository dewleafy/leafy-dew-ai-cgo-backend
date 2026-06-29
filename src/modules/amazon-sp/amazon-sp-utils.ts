import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function toIntegerOrNull(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  return numeric === null ? null : Math.trunc(numeric);
}

export function sanitizeAmazonSpValue(value: string | undefined): string | undefined {
  if (!value) return value;

  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.ENCRYPTION_KEY,
    env.SP_API_TOKEN_ENCRYPTION_KEY,
    env.SP_API_LWA_CLIENT_ID,
    env.SP_API_LWA_CLIENT_SECRET,
    env.SP_API_REFRESH_TOKEN,
    env.SP_API_AWS_ACCESS_KEY_ID,
    env.SP_API_AWS_SECRET_ACCESS_KEY,
    env.SP_API_AWS_SESSION_TOKEN,
    process.env.AWS_ACCESS_KEY_ID,
    process.env.AWS_SECRET_ACCESS_KEY,
    process.env.AWS_SESSION_TOKEN
  ].filter((secret): secret is string => Boolean(secret));

  return secretValues.reduce(
    (safeValue, secretValue) => safeValue.replaceAll(secretValue, "[REDACTED]"),
    value
  );
}

export function logSafeAmazonSpError(context: string, error: { message?: string; code?: string; details?: string; hint?: string }): void {
  logger.warn(context, {
    message: sanitizeAmazonSpValue(error.message),
    code: sanitizeAmazonSpValue(error.code),
    details: sanitizeAmazonSpValue(error.details),
    hint: sanitizeAmazonSpValue(error.hint)
  });
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeAmazonSpValue(error.message) ?? "Amazon SP-API request failed.";
  }

  return "Amazon SP-API request failed.";
}

export async function smallDelay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
