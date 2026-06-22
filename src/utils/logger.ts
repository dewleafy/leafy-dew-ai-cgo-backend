const SENSITIVE_KEYS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
  "x-amz-access-token",
  "token",
  "secret"
];

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
        key.toLowerCase().includes(sensitiveKey)
      );
      redacted[key] = isSensitive ? "[REDACTED]" : redactValue(item);
    }

    return redacted;
  }

  return value;
}

export const logger = {
  info(message: string, meta?: unknown) {
    console.log(message, meta ? redactValue(meta) : "");
  },
  warn(message: string, meta?: unknown) {
    console.warn(message, meta ? redactValue(meta) : "");
  },
  error(message: string, meta?: unknown) {
    console.error(message, meta ? redactValue(meta) : "");
  }
};
