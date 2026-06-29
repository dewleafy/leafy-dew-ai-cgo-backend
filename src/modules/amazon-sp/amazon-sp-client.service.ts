import axios from "axios";
import { getAmazonSpEndpoint } from "./amazon-sp-auth.service";
import { AmazonSpRegion } from "./amazon-sp.types";
import { AmazonSpHttpError, safeErrorMessage, sanitizeAmazonSpValue, smallDelay } from "./amazon-sp-utils";

function firstAmazonError(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const errors = (data as Record<string, unknown>).errors;
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
    return errors[0] as Record<string, unknown>;
  }

  return {};
}

function responseHeader(headers: unknown, keys: string[]): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const record = headers as Record<string, unknown>;
  for (const key of keys) {
    const exact = record[key];
    const lower = record[key.toLowerCase()];
    const value = exact ?? lower;
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

export async function amazonSpGet<T>(input: {
  path: string;
  query?: Record<string, string | number | undefined>;
  accessToken: string;
  region: AmazonSpRegion;
}): Promise<T> {
  const url = new URL(input.path, getAmazonSpEndpoint(input.region));
  Object.entries(input.query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const headers = {
    "x-amz-access-token": input.accessToken,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "LeafyDew/1.0"
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await axios.get<T>(url.toString(), { headers });
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (attempt < 3 && (status === 429 || (status !== undefined && status >= 500))) {
        await smallDelay(700 * attempt);
        continue;
      }

      if (axios.isAxiosError(error) && error.response?.status) {
        const amazonError = firstAmazonError(error.response.data);
        const requestId = responseHeader(error.response.headers, [
          "x-amzn-RequestId",
          "x-amzn-requestid",
          "x-amzn-request-id",
          "x-amz-request-id"
        ]);

        throw new AmazonSpHttpError({
          httpStatus: error.response.status,
          amazonErrorCode: sanitizeAmazonSpValue(
            typeof amazonError.code === "string" ? amazonError.code : undefined
          ),
          amazonErrorMessage: sanitizeAmazonSpValue(
            typeof amazonError.message === "string" ? amazonError.message : undefined
          ),
          amazonErrorDetails: sanitizeAmazonSpValue(
            typeof amazonError.details === "string" ? amazonError.details : undefined
          ),
          requestId: sanitizeAmazonSpValue(requestId),
          method: "GET",
          path: url.pathname
        });
      }

      throw new Error(safeErrorMessage(error));
    }
  }

  throw new Error("Amazon SP-API request failed.");
}
