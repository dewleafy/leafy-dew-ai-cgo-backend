import axios, { AxiosRequestConfig } from "axios";
import crypto from "crypto";
import { env } from "../../config/env";
import { getAmazonSpEndpoint } from "./amazon-sp-auth.service";
import { AmazonSpRegion } from "./amazon-sp.types";
import { safeErrorMessage, smallDelay } from "./amazon-sp-utils";

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

function getAwsCredentials(): AwsCredentials {
  const accessKeyId = env.SP_API_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.SP_API_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = env.SP_API_AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing AWS SigV4 credentials for SP-API. Set SP_API_AWS_ACCESS_KEY_ID and SP_API_AWS_SECRET_ACCESS_KEY.");
  }

  return { accessKeyId, secretAccessKey, sessionToken };
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  params.forEach((value, key) => pairs.push([key, value]));
  return pairs
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function regionToAwsRegion(region: AmazonSpRegion): string {
  if (region === "NA") return "us-east-1";
  if (region === "EU") return "eu-west-1";
  return "us-west-2";
}

function signRequest(input: {
  method: string;
  url: URL;
  region: AmazonSpRegion;
  accessToken: string;
  body?: string;
}): Record<string, string> {
  const credentials = getAwsCredentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payload = input.body ?? "";
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-access-token": input.accessToken,
    "x-amz-date": amzDate
  };

  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload)
  ].join("\n");

  const awsRegion = regionToAwsRegion(input.region);
  const credentialScope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", getSigningKey(credentials.secretAccessKey, dateStamp, awsRegion, "execute-api"))
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
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

  const headers = signRequest({
    method: "GET",
    url,
    region: input.region,
    accessToken: input.accessToken
  });
  const config: AxiosRequestConfig = { headers };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await axios.get<T>(url.toString(), config);
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (attempt < 3 && (status === 429 || (status !== undefined && status >= 500))) {
        await smallDelay(700 * attempt);
        continue;
      }
      throw new Error(safeErrorMessage(error));
    }
  }

  throw new Error("Amazon SP-API request failed.");
}
