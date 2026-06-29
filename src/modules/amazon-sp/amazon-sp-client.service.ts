import axios from "axios";
import { getAmazonSpEndpoint } from "./amazon-sp-auth.service";
import { AmazonSpRegion } from "./amazon-sp.types";
import { AmazonSpHttpError, safeErrorMessage, sanitizeAmazonSpValue, smallDelay } from "./amazon-sp-utils";

type AmazonSpQueryValue = string | number | Array<string | number> | null | undefined;

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
  query?: Record<string, AmazonSpQueryValue>;
  accessToken: string;
  region: AmazonSpRegion;
  stage?: string;
}): Promise<T> {
  return amazonSpRequest<T>({
    method: "GET",
    path: input.path,
    query: input.query,
    accessToken: input.accessToken,
    region: input.region,
    stage: input.stage
  });
}

export async function amazonSpPost<T>(input: {
  path: string;
  query?: Record<string, AmazonSpQueryValue>;
  body?: Record<string, unknown>;
  accessToken: string;
  region: AmazonSpRegion;
  stage?: string;
}): Promise<T> {
  return amazonSpRequest<T>({
    method: "POST",
    path: input.path,
    query: input.query,
    body: input.body,
    accessToken: input.accessToken,
    region: input.region,
    stage: input.stage
  });
}

async function amazonSpRequest<T>(input: {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, AmazonSpQueryValue>;
  body?: Record<string, unknown>;
  accessToken: string;
  region: AmazonSpRegion;
  stage?: string;
}): Promise<T> {
  const url = new URL(input.path, getAmazonSpEndpoint(input.region));
  const safeQuery: Record<string, string | number> = {};

  Object.entries(input.query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return;
      }

      const serialized = value.join(",");
      url.searchParams.set(key, serialized);
      safeQuery[key] = serialized;
      return;
    }

    url.searchParams.set(key, String(value));
    safeQuery[key] = value;
  });

  const headers = {
    "x-amz-access-token": input.accessToken,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "LeafyDew/1.0"
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = input.method === "GET"
        ? await axios.get<T>(url.toString(), { headers })
        : await axios.post<T>(url.toString(), input.body ?? {}, { headers });
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
          stage: input.stage,
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
          method: input.method,
          path: url.pathname,
          safeQuery
        });
      }

      throw new Error(safeErrorMessage(error));
    }
  }

  throw new Error("Amazon SP-API request failed.");
}
