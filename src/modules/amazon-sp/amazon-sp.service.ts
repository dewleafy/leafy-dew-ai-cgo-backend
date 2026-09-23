import axios from "axios";
import { gunzipSync } from "zlib";
import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { createActivityLog } from "../activity-logs/activity-logs.service";
import {
  buildAmazonSpConnectUrl,
  exchangeAmazonSpAuthorizationCode,
  getAmazonSpConfigCheck,
  getAmazonSpMarketplaceId,
  getAmazonSpRegion,
  parseAmazonSpState
} from "./amazon-sp-auth.service";
import { amazonSpGet, amazonSpPost } from "./amazon-sp-client.service";
import {
  AMAZON_SP_ENV_CONNECTION_ID,
  encryptAmazonSpRefreshToken,
  getAmazonSpAccessToken
} from "./amazon-sp-token.service";
import {
  normalizeProductImage,
  normalizeProductMedia
} from "../product-media/product-media-normalizer";
import { getProductImageLookup, lookupProductImage } from "../product-passports/product-passports.service";
import {
  AmazonSpConnectionRow,
  AmazonSpListingRow,
  AmazonSpOrderItemRow,
  AmazonSpOrderRow,
  SafeAmazonSpListing,
  SafeAmazonSpOrder
} from "./amazon-sp.types";
import {
  cleanText,
  logSafeAmazonSpError,
  safeErrorDetails,
  safeErrorMessage,
  sanitizeAmazonSpValue,
  smallDelay,
  toIntegerOrNull,
  toNumberOrNull
} from "./amazon-sp-utils";

const LISTINGS_REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const ORDERS_REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
const ORDERS_REPORT_LAST_UPDATE_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL";
const LISTINGS_REPORT_PROCESSING_STATUSES = new Set(["IN_QUEUE", "IN_PROGRESS"]);
const LISTINGS_REPORT_STOP_STATUSES = new Set(["DONE", "DONE_NO_DATA", "CANCELLED", "FATAL"]);
const ORDER_REPORT_PROCESSING_STATUSES = new Set(["IN_QUEUE", "IN_PROGRESS"]);
const ORDER_REPORT_STOP_STATUSES = new Set(["DONE", "DONE_NO_DATA", "CANCELLED", "FATAL"]);

type ListingSyncItem = {
  sku: string;
  asin: string | null;
  productName: string | null;
  listingStatus: string | null;
  fulfillmentChannel: string | null;
  price: number | null;
  currency: string | null;
  quantity: number | null;
  productType: string | null;
  mainImageUrl: string | null;
  rawPayload: Record<string, unknown>;
};

type OrderSyncItem = {
  amazonOrderId: string;
  purchaseDate: string | null;
  orderStatus: string | null;
  fulfillmentChannel: string | null;
  salesChannel: string | null;
  orderTotalAmount: number | null;
  orderTotalCurrency: string | null;
  numberOfItemsShipped: number | null;
  numberOfItemsUnshipped: number | null;
  rawPayload: Record<string, unknown>;
};

type OrderItemSyncItem = {
  amazonOrderId: string;
  orderItemId: string;
  asin: string | null;
  sku: string | null;
  title: string | null;
  quantityOrdered: number | null;
  quantityShipped: number | null;
  itemPriceAmount: number | null;
  itemPriceCurrency: string | null;
  itemTaxAmount: number | null;
  promotionDiscountAmount: number | null;
  rawPayload: Record<string, unknown>;
};

type AmazonSpReportResponse = {
  reportId?: string;
  reportType?: string;
  processingStatus?: string;
  reportDocumentId?: string;
};

type AmazonSpReportDocumentResponse = {
  reportDocumentId?: string;
  url?: string;
  compressionAlgorithm?: string;
};

type OrderReportParsedResult = {
  orders: OrderSyncItem[];
  orderItems: OrderItemSyncItem[];
  skippedCount: number;
  totalSales: number;
  totalUnits: number;
};

type OrderReportDiagnosis =
  | "REPORT_HAS_NO_DATA_ROWS"
  | "REPORT_HAS_ROWS_BUT_MAPPING_FAILED"
  | "REPORT_HAS_ROWS_AND_MAPPING_WORKS"
  | "REPORT_PROCESSING"
  | "REPORT_FAILED"
  | "UNKNOWN";

type SafeDbErrorDetails = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

type OrderItemSaveResult = {
  savedOrderItems: number;
  failedOrderItems: number;
  dbErrorCode?: string;
  dbErrorMessage?: string;
  dbErrorDetails?: string;
  failedRowsSafe: Array<{
    rowIndex: number;
    amazonOrderIdPresent: boolean;
    orderItemIdPresent: boolean;
    sku: string | null;
    asin: string | null;
    quantity: number | null;
    itemPrice: number | null;
    orderStatus: string | null;
  }>;
};

type AmazonSpReportJobType = "LISTINGS_IMPORT" | "ORDER_IMPORT";

type AmazonSpReportJobRow = {
  id: string;
  seller_id: string;
  marketplace_id: string;
  report_id: string;
  report_type: string;
  job_type: AmazonSpReportJobType;
  status: string;
  data_start_time: string | null;
  data_end_time: string | null;
  last_attempt_at: string | null;
  processed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type DoctorDiagnosis =
  | "CONFIG_MISSING"
  | "TOKEN_FAILED"
  | "MARKETPLACE_NOT_FOUND_FOR_TOKEN"
  | "REPORTS_API_ALLOWED"
  | "REPORTS_API_DENIED"
  | "LISTINGS_ITEMS_DENIED"
  | "UNKNOWN_NEEDS_REVIEW";

function sellerIdOrDefault(sellerId?: string): string {
  return cleanText(sellerId) ?? "default";
}

function toSafeListing(row: AmazonSpListingRow): SafeAmazonSpListing {
  const media = normalizeProductMedia(row, {
    lastImageSyncAt: row.last_synced_at,
    amazonImagePreferred: true
  });

  return {
    id: row.id,
    sellerId: row.seller_id,
    amazonSellerId: row.amazon_seller_id,
    marketplaceId: row.marketplace_id,
    sku: row.sku,
    asin: row.asin,
    productName: row.product_name,
    listingStatus: row.listing_status,
    fulfillmentChannel: row.fulfillment_channel,
    price: toNumberOrNull(row.price),
    currency: row.currency,
    quantity: row.quantity,
    productType: row.product_type,
    mainImageUrl: media.mainImageUrl,
    imageUrl: media.imageUrl,
    amazonImageUrl: media.amazonImageUrl,
    imageSource: media.imageSource,
    lastImageSyncAt: media.lastImageSyncAt,
    images: media.images,
    imageStatus: media.imageStatus,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeOrder(row: AmazonSpOrderRow): SafeAmazonSpOrder {
  return {
    id: row.id,
    sellerId: row.seller_id,
    marketplaceId: row.marketplace_id,
    amazonOrderId: row.amazon_order_id,
    purchaseDate: row.purchase_date,
    orderStatus: row.order_status,
    fulfillmentChannel: row.fulfillment_channel,
    salesChannel: row.sales_channel,
    orderTotalAmount: toNumberOrNull(row.order_total_amount),
    orderTotalCurrency: row.order_total_currency,
    numberOfItemsShipped: row.number_of_items_shipped,
    numberOfItemsUnshipped: row.number_of_items_unshipped,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function logSpActivity(input: {
  sellerId: string;
  action: string;
  status: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await createActivityLog({
      sellerId: input.sellerId,
      eventType: "AMAZON_SP_SYNC",
      entityType: "AMAZON_SP",
      action: input.action,
      status: input.status,
      message: input.message,
      metadata: input.metadata ?? {}
    });
  } catch {
    // Activity logging should never break sync flows.
  }
}

export { buildAmazonSpConnectUrl, getAmazonSpConfigCheck };

export async function handleAmazonSpOAuthCallback(input: {
  code: string;
  state?: string;
  amazonSellerId?: string | null;
}): Promise<{ sellerId: string; marketplaceId: string; region: string }> {
  const parsedState = input.state
    ? parseAmazonSpState(input.state)
    : {
        sellerId: "default",
        marketplaceId: getAmazonSpMarketplaceId(),
        region: getAmazonSpRegion()
      };
  const sellerId = sellerIdOrDefault(parsedState.sellerId);
  const tokenResponse = await exchangeAmazonSpAuthorizationCode(input.code);

  if (!tokenResponse.refresh_token) {
    throw new Error("Amazon did not return a refresh token. Please reconnect Seller Central.");
  }

  const { error } = await supabase.from("amazon_sp_connections").upsert(
    {
      seller_id: sellerId,
      amazon_seller_id: cleanText(input.amazonSellerId ?? null),
      marketplace_id: parsedState.marketplaceId,
      region: parsedState.region,
      refresh_token_encrypted: encryptAmazonSpRefreshToken(tokenResponse.refresh_token),
      token_status: "CONNECTED",
      last_connected_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "seller_id,marketplace_id" }
  );

  if (error) {
    logSafeAmazonSpError("Could not save Amazon SP-API connection.", error);
    throw new Error("Could not save Amazon SP-API connection in Supabase.");
  }

  await logSpActivity({
    sellerId,
    action: "CONNECT_SELLER_CENTRAL",
    status: "SUCCESS",
    message: "Amazon Seller Central connected in read-only shadow mode."
  });

  return {
    sellerId,
    marketplaceId: parsedState.marketplaceId,
    region: parsedState.region
  };
}

async function getConnection(sellerIdInput: string): Promise<AmazonSpConnectionRow | null> {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const { data, error } = await supabase
    .from("amazon_sp_connections")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("marketplace_id", getAmazonSpMarketplaceId())
    .maybeSingle<AmazonSpConnectionRow>();

  if (error) {
    logSafeAmazonSpError("Could not load Amazon SP-API connection.", error);
    throw new Error("Could not load Amazon SP-API connection from Supabase.");
  }

  return data;
}

export async function getAmazonSpStatus(sellerIdInput: string) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const connection = await getConnection(sellerId);
  const hasDbToken = Boolean(connection?.refresh_token_encrypted);
  const hasEnvToken = Boolean(env.SP_API_REFRESH_TOKEN);
  const [listingStats, orderStats] = await Promise.all([
    getTableStats("amazon_sp_listings", sellerId),
    getTableStats("amazon_sp_orders", sellerId)
  ]);

  return {
    sellerId,
    connected: connection?.token_status === "CONNECTED" || (!hasDbToken && hasEnvToken),
    tokenStatus: !hasDbToken && hasEnvToken ? "CONNECTED_ENV" : connection?.token_status ?? "DISCONNECTED",
    marketplaceId: connection?.marketplace_id ?? getAmazonSpMarketplaceId(),
    region: connection?.region ?? getAmazonSpRegion(),
    lastConnectedAt: connection?.last_connected_at ?? null,
    lastListingsSyncAt: listingStats.lastSyncedAt,
    lastOrdersSyncAt: orderStats.lastSyncedAt,
    listingCount: listingStats.count,
    orderCount: orderStats.count,
    lastError: connection?.last_error ?? null
  };
}

function safeAmazonError(stage: string, error: unknown) {
  const details = safeErrorDetails(error);

  return typeof details === "string"
    ? {
        stage,
        amazonErrorMessage: details
      }
    : {
        stage,
        ...details
      };
}

function normalizeMarketplaceParticipations(response: unknown) {
  const payload = response && typeof response === "object"
    ? (response as Record<string, unknown>).payload
    : undefined;
  const rows = Array.isArray(payload) ? payload : [];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => {
      const marketplace = row.marketplace && typeof row.marketplace === "object"
        ? row.marketplace as Record<string, unknown>
        : {};
      const participation = row.participation && typeof row.participation === "object"
        ? row.participation as Record<string, unknown>
        : {};

      return {
        marketplaceId: typeof marketplace.id === "string" ? marketplace.id : null,
        countryCode: typeof marketplace.countryCode === "string" ? marketplace.countryCode : null,
        name: typeof marketplace.name === "string" ? marketplace.name : null,
        defaultCurrencyCode: typeof marketplace.defaultCurrencyCode === "string" ? marketplace.defaultCurrencyCode : null,
        defaultLanguageCode: typeof marketplace.defaultLanguageCode === "string" ? marketplace.defaultLanguageCode : null,
        isParticipating: Boolean(participation.isParticipating),
        hasSuspendedListings: Boolean(participation.hasSuspendedListings)
      };
    });
}

export async function runAmazonSpDoctor(sellerIdInput: string) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const connection = await getConnection(sellerId);
  const selectedMarketplaceId = connection?.marketplace_id ?? getAmazonSpMarketplaceId();
  const selectedRegion = connection?.region ?? getAmazonSpRegion();
  const configCheck = getAmazonSpConfigCheck();
  const config = {
    hasClientId: configCheck.hasClientId,
    hasClientSecret: configCheck.hasClientSecret,
    hasApplicationId: configCheck.hasApplicationId,
    hasRefreshToken: Boolean(connection?.refresh_token_encrypted || env.SP_API_REFRESH_TOKEN),
    hasMarketplaceId: configCheck.hasMarketplaceId,
    hasRedirectUri: configCheck.hasRedirectUri,
    region: selectedRegion,
    marketplaceId: selectedMarketplaceId
  };
  const result: Record<string, unknown> = {
    ok: true,
    sellerId,
    config,
    tokenOk: false,
    marketplaceParticipations: [],
    selectedMarketplaceFound: false,
    reportsApiOk: false,
    listingsItemsProbeSkipped: false,
    finalDiagnosis: "UNKNOWN_NEEDS_REVIEW" satisfies DoctorDiagnosis
  };

  if (
    !config.hasClientId ||
    !config.hasClientSecret ||
    !config.hasApplicationId ||
    !config.hasRefreshToken ||
    !config.hasMarketplaceId ||
    !config.hasRedirectUri
  ) {
    result.finalDiagnosis = "CONFIG_MISSING" satisfies DoctorDiagnosis;
    return result;
  }

  let doctorConnection: AmazonSpConnectionRow;
  let accessToken: string;

  try {
    doctorConnection = await requireConnectedConnection(sellerId);
    accessToken = await getAmazonSpAccessToken(doctorConnection.id);
    result.tokenOk = true;
  } catch (error) {
    result.tokenError = safeAmazonError("TOKEN_TEST", error);
    result.finalDiagnosis = "TOKEN_FAILED" satisfies DoctorDiagnosis;
    return result;
  }

  try {
    const participationResponse = await amazonSpGet<unknown>({
      path: "/sellers/v1/marketplaceParticipations",
      accessToken,
      region: doctorConnection.region
    });
    const participations = normalizeMarketplaceParticipations(participationResponse);
    const selected = participations.some((row) => row.marketplaceId === selectedMarketplaceId);
    result.marketplaceParticipations = participations;
    result.selectedMarketplaceFound = selected;

    if (!selected) {
      result.finalDiagnosis = "MARKETPLACE_NOT_FOUND_FOR_TOKEN" satisfies DoctorDiagnosis;
      return result;
    }
  } catch (error) {
    result.marketplaceParticipationError = safeAmazonError("MARKETPLACE_PARTICIPATION_TEST", error);
    result.finalDiagnosis = "MARKETPLACE_NOT_FOUND_FOR_TOKEN" satisfies DoctorDiagnosis;
    return result;
  }

  try {
    const reportResponse = await amazonSpPost<Record<string, unknown>>({
      path: "/reports/2021-06-30/reports",
      accessToken,
      region: doctorConnection.region,
      body: {
        reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
        marketplaceIds: [selectedMarketplaceId]
      }
    });

    result.reportsApiOk = true;
    result.reportId = typeof reportResponse.reportId === "string" ? reportResponse.reportId : null;
    result.reportType = "GET_MERCHANT_LISTINGS_ALL_DATA";
    result.marketplaceId = selectedMarketplaceId;
    result.finalDiagnosis = "REPORTS_API_ALLOWED" satisfies DoctorDiagnosis;
  } catch (error) {
    result.reportsApiOk = false;
    result.reportsApiError = safeAmazonError("REPORTS_API_PROBE", error);
    result.finalDiagnosis = "REPORTS_API_DENIED" satisfies DoctorDiagnosis;
  }

  const amazonSellerId = cleanText(doctorConnection.amazon_seller_id) ?? cleanText(env.SP_API_AMAZON_SELLER_ID);

  if (!amazonSellerId) {
    result.listingsItemsProbeSkipped = true;
    result.reason = "amazonSellerId is not confirmed";
    return result;
  }

  try {
    await amazonSpGet<unknown>({
      path: `/listings/2021-08-01/items/${encodeURIComponent(amazonSellerId)}`,
      accessToken,
      region: doctorConnection.region,
      query: {
        marketplaceIds: selectedMarketplaceId,
        includedData: "summaries",
        pageSize: 20
      }
    });

    result.listingsItemsProbeOk = true;
  } catch (error) {
    result.listingsItemsProbeOk = false;
    result.listingsItemsProbeError = safeAmazonError("LISTINGS_ITEMS_PROBE", error);
    result.finalDiagnosis = "LISTINGS_ITEMS_DENIED" satisfies DoctorDiagnosis;
  }

  return result;
}

async function getTableStats(table: string, sellerId: string): Promise<{ count: number; lastSyncedAt: string | null }> {
  const { count, error: countError } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId);

  if (countError) {
    logSafeAmazonSpError(`Could not count ${table}.`, countError);
    return { count: 0, lastSyncedAt: null };
  }

  const { data, error } = await supabase
    .from(table)
    .select("last_synced_at")
    .eq("seller_id", sellerId)
    .order("last_synced_at", { ascending: false })
    .limit(1);

  if (error) {
    logSafeAmazonSpError(`Could not load latest sync for ${table}.`, error);
  }

  const latest = Array.isArray(data) && data[0] ? (data[0] as { last_synced_at?: string }).last_synced_at ?? null : null;
  return { count: count ?? 0, lastSyncedAt: latest };
}

function extractListings(response: unknown): { items: ListingSyncItem[]; nextToken?: string } {
  const payload = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const pagination = payload.pagination && typeof payload.pagination === "object" ? payload.pagination as Record<string, unknown> : {};

  return {
    nextToken: typeof pagination.nextToken === "string" ? pagination.nextToken : undefined,
    items: rawItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => {
        const summaries = Array.isArray(item.summaries) ? item.summaries as Record<string, unknown>[] : [];
        const summary = summaries[0] ?? {};
        const offers = Array.isArray(item.offers) ? item.offers as Record<string, unknown>[] : [];
        const offer = offers[0] ?? {};
        const availability = Array.isArray(item.fulfillmentAvailability) ? item.fulfillmentAvailability as Record<string, unknown>[] : [];
        const firstAvailability = availability[0] ?? {};
        const price = offer.price && typeof offer.price === "object" ? offer.price as Record<string, unknown> : {};
        const mainImageUrl = normalizeProductImage(item);
        return {
          sku: String(item.sku ?? ""),
          asin: cleanText(String(summary.asin ?? item.asin ?? "")),
          productName: cleanText(String(summary.itemName ?? item.itemName ?? "")),
          listingStatus: cleanText(String(summary.status?.toString() ?? "")),
          fulfillmentChannel: cleanText(String(firstAvailability.fulfillmentChannelCode ?? "")),
          price: toNumberOrNull(price.amount),
          currency: cleanText(String(price.currencyCode ?? "")),
          quantity: toIntegerOrNull(firstAvailability.quantity),
          productType: cleanText(String(summary.productType ?? item.productType ?? "")),
          mainImageUrl,
          rawPayload: item
        };
      })
      .filter((item) => item.sku.length > 0)
  };
}

function reportValue(row: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    const value = cleanText(row[name]);
    if (value) return value;
  }

  return null;
}

function reportNumber(row: Record<string, string>, names: string[]): number | null {
  const value = reportValue(row, names);
  if (!value) return null;

  const normalized = value.replace(/,/g, "").replace(/[^\d.-]/g, "");
  return toNumberOrNull(normalized);
}

function amazonOrderIdFromReportRow(row: Record<string, string>): string | null {
  return reportValue(row, ["amazon-order-id", "order-id", "merchant-order-id"]);
}

function orderItemIdFromReportRow(row: Record<string, string>, amazonOrderId: string, rowIndex: number): string | null {
  const orderItemId = reportValue(row, ["order-item-id"]);
  if (orderItemId) return orderItemId;

  const sku = reportValue(row, ["sku"]);
  return sku ? `${amazonOrderId}-${sku}-${rowIndex}` : null;
}

function splitTabDelimitedLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (quoted && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "\t" && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseListingReportText(text: string): { listings: ListingSyncItem[]; skippedCount: number; distinctSkuCount: number } {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const lines = withoutBom
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { listings: [], skippedCount: 0, distinctSkuCount: 0 };
  }

  const headers = splitTabDelimitedLine(lines[0]).map((header) => header.trim().toLowerCase());
  const listings: ListingSyncItem[] = [];
  let skippedCount = 0;

  for (const [rowOffset, line] of lines.slice(1).entries()) {
    const rowIndex = rowOffset + 1;
    const cells = splitTabDelimitedLine(line);
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });

    if (Object.values(row).every((value) => value.length === 0)) {
      continue;
    }

    const sku = reportValue(row, ["seller-sku", "sku"]);
    if (!sku) {
      skippedCount += 1;
      continue;
    }

    const productType = reportValue(row, ["product-type", "product_type", "category"]);

    listings.push({
      sku,
      asin: reportValue(row, ["asin1", "asin"]),
      productName: reportValue(row, ["item-name", "title"]),
      listingStatus: reportValue(row, ["status", "item-is-marketplace"]),
      fulfillmentChannel: reportValue(row, ["fulfillment-channel"]),
      price: toNumberOrNull(reportValue(row, ["price"])),
      currency: "INR",
      quantity: toIntegerOrNull(reportValue(row, ["quantity"])),
      productType,
      mainImageUrl: reportValue(row, ["image-url"]),
      rawPayload: row
    });
  }

  const distinctSkuCount = new Set(listings.map((item) => item.sku)).size;
  return { listings, skippedCount, distinctSkuCount };
}

async function getListingsReportStatus(
  accessToken: string,
  region: AmazonSpConnectionRow["region"],
  reportId: string
): Promise<AmazonSpReportResponse> {
  return amazonSpGet<AmazonSpReportResponse>({
    path: `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
    accessToken,
    region,
    stage: "GET_LISTINGS_REPORT"
  });
}

async function createListingsReport(
  accessToken: string,
  region: AmazonSpConnectionRow["region"],
  marketplaceId: string
): Promise<string> {
  const response = await amazonSpPost<AmazonSpReportResponse>({
    path: "/reports/2021-06-30/reports",
    accessToken,
    region,
    stage: "CREATE_LISTINGS_REPORT",
    body: {
      reportType: LISTINGS_REPORT_TYPE,
      marketplaceIds: [marketplaceId]
    }
  });

  if (!response.reportId) {
    throw new Error("Amazon did not return a listing report id.");
  }

  return response.reportId;
}

async function waitForListingsReport(input: {
  accessToken: string;
  region: AmazonSpConnectionRow["region"];
  marketplaceId: string;
  reportId?: string;
}): Promise<{ reportId: string; report: AmazonSpReportResponse }> {
  const reportId = input.reportId ?? await createListingsReport(input.accessToken, input.region, input.marketplaceId);

  if (input.reportId) {
    return {
      reportId,
      report: await getListingsReportStatus(input.accessToken, input.region, reportId)
    };
  }

  let report: AmazonSpReportResponse = { reportId, processingStatus: "IN_QUEUE" };

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    report = await getListingsReportStatus(input.accessToken, input.region, reportId);
    const status = report.processingStatus ?? "UNKNOWN";
    if (LISTINGS_REPORT_STOP_STATUSES.has(status)) {
      break;
    }

    if (attempt < 6) {
      await smallDelay(10000);
    }
  }

  return { reportId, report };
}

async function loadAmazonSpReportDocument(input: {
  accessToken: string;
  region: AmazonSpConnectionRow["region"];
  reportDocumentId: string;
  stage: string;
}): Promise<string> {
  const document = await amazonSpGet<AmazonSpReportDocumentResponse>({
    path: `/reports/2021-06-30/documents/${encodeURIComponent(input.reportDocumentId)}`,
    accessToken: input.accessToken,
    region: input.region,
    stage: input.stage
  });

  if (!document.url) {
    throw new Error("Amazon did not return a listing report document.");
  }

  try {
    const response = await axios.get<ArrayBuffer>(document.url, {
      responseType: "arraybuffer",
      headers: {
        "user-agent": "LeafyDew/1.0"
      }
    });
    const body = Buffer.from(response.data);
    const decompressed = document.compressionAlgorithm?.toUpperCase() === "GZIP" ? gunzipSync(body) : body;
    return decompressed.toString("utf8");
  } catch {
    throw new Error("Could not download Amazon report document.");
  }
}

async function upsertAmazonSpListingRows(input: {
  sellerId: string;
  connection: AmazonSpConnectionRow;
  listings: ListingSyncItem[];
}): Promise<void> {
  if (input.listings.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("amazon_sp_listings")
    .upsert(
      input.listings.map((listing) => ({
        seller_id: input.sellerId,
        amazon_seller_id: input.connection.amazon_seller_id,
        marketplace_id: input.connection.marketplace_id,
        sku: listing.sku,
        asin: listing.asin,
        product_name: listing.productName,
        listing_status: listing.listingStatus,
        fulfillment_channel: listing.fulfillmentChannel,
        price: listing.price,
        currency: listing.currency,
        quantity: listing.quantity,
        product_type: listing.productType,
        main_image_url: listing.mainImageUrl,
        raw_payload: listing.rawPayload,
        last_synced_at: now,
        updated_at: now
      })),
      { onConflict: "seller_id,marketplace_id,sku" }
    );

  if (error) {
    logSafeAmazonSpError("Could not upsert Amazon SP-API listings.", error);
    throw new Error("Could not save Amazon SP-API listings in Supabase.");
  }
}

function listingLooksActive(status: string | null): boolean {
  const normalized = status?.toUpperCase() ?? "";
  return (
    normalized === "Y" ||
    normalized === "YES" ||
    normalized === "TRUE" ||
    normalized.includes("ACTIVE") ||
    normalized.includes("OPEN") ||
    normalized.includes("BUYABLE")
  );
}

export async function syncAmazonSpListings(input: { sellerId: string; reportId?: string } | string) {
  const sellerIdInput = typeof input === "string" ? input : input.sellerId;
  const requestedReportId = typeof input === "string" ? undefined : cleanText(input.reportId) ?? undefined;
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const connection = await requireConnectedConnection(sellerId);
  const warnings: string[] = [];

  await logSpActivity({ sellerId, action: "SYNC_LISTINGS_STARTED", status: "INFO", message: "Amazon SP-API listing sync started." });

  try {
    const accessToken = await getAmazonSpAccessToken(connection.id);
    const { reportId, report } = await waitForListingsReport({
      accessToken,
      region: connection.region,
      marketplaceId: connection.marketplace_id,
      reportId: requestedReportId
    });
    const status = report.processingStatus ?? "UNKNOWN";

    if (LISTINGS_REPORT_PROCESSING_STATUSES.has(status)) {
      return {
        ok: true,
        source: "REPORTS_API",
        status: "PROCESSING",
        reportId,
        message: "Amazon listing report is processing. Retry sync-listings with this reportId in a few minutes."
      };
    }

    if (status === "CANCELLED" || status === "FATAL" || status === "DONE_NO_DATA") {
      await updateConnectionError(connection.id, null);
      await logSpActivity({
        sellerId,
        action: "SYNC_LISTINGS_COMPLETED",
        status: status === "DONE_NO_DATA" ? "SUCCESS" : "WARNING",
        message: `Amazon listing report finished with status ${status}.`,
        metadata: { source: "REPORTS_API", reportId, reportStatus: status }
      });

      return {
        ok: true,
        source: "REPORTS_API",
        reportType: LISTINGS_REPORT_TYPE,
        reportId,
        status,
        syncedCount: 0,
        upsertedProductPassports: 0,
        skippedCount: 0,
        warnings
      };
    }

    if (status !== "DONE" || !report.reportDocumentId) {
      throw new Error("Amazon listing report did not finish with a downloadable document.");
    }

    const reportText = await loadAmazonSpReportDocument({
      accessToken,
      region: connection.region,
      reportDocumentId: report.reportDocumentId,
      stage: "GET_LISTINGS_REPORT_DOCUMENT"
    });
    const { listings, skippedCount, distinctSkuCount } = parseListingReportText(reportText);

    await upsertAmazonSpListingRows({ sellerId, connection, listings });
    const { inserted: newProductsCount, updated: updatedProductsCount } = await upsertProductPassportsFromListings(sellerId, listings);
    const passportCount = newProductsCount + updatedProductsCount;
    await updateConnectionError(connection.id, null);
    await logSpActivity({
      sellerId,
      action: "SYNC_LISTINGS_COMPLETED",
      status: "SUCCESS",
      message: "Amazon SP-API listing sync completed.",
      metadata: {
        source: "REPORTS_API",
        reportId,
        syncedCount: listings.length,
        distinctSkuCount,
        upsertedProductPassports: passportCount,
        newProductsCount,
        updatedProductsCount,
        skippedCount
      }
    });

    return {
      ok: true,
      source: "REPORTS_API",
      reportType: LISTINGS_REPORT_TYPE,
      reportId,
      syncedCount: listings.length,
      distinctSkuCount,
      upsertedProductPassports: passportCount,
      newProductsCount,
      updatedProductsCount,
      skippedCount,
      warnings
    };
  } catch (error) {
    await updateConnectionError(connection.id, safeErrorMessage(error));
    await logSpActivity({
      sellerId,
      action: "SYNC_LISTINGS_FAILED",
      status: "ERROR",
      message: safeErrorMessage(error)
    });
    throw error;
  }
}

async function findProductPassportForListing(
  sellerId: string,
  listing: ListingSyncItem
): Promise<Record<string, unknown> | undefined> {
  const { data: skuRows, error: skuError } = await supabase
    .from("product_passports")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("sku", listing.sku)
    .limit(1);

  if (skuError) {
    logSafeAmazonSpError("Could not load product passport by SKU during listing import.", skuError);
    return undefined;
  }

  const skuMatch = Array.isArray(skuRows) ? skuRows[0] as Record<string, unknown> | undefined : undefined;
  if (skuMatch || !listing.asin) {
    return skuMatch;
  }

  const { data: asinRows, error: asinError } = await supabase
    .from("product_passports")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("asin", listing.asin)
    .limit(1);

  if (asinError) {
    logSafeAmazonSpError("Could not load product passport by ASIN during listing import.", asinError);
    return undefined;
  }

  return Array.isArray(asinRows) ? asinRows[0] as Record<string, unknown> | undefined : undefined;
}

// Real fix for a long-documented bug: this sync used to hardcode brand: "Leafy Dew" on every
// product it created, mislabeling every Ziro kart product too (this seller sells two brands
// under one Amazon account). Detects the real brand from the SKU/product name instead — the
// same detection Brand Readiness uses — so newly-synced products get the correct brand, and
// existing mislabeled rows self-heal the next time this sync updates them (belt-and-suspenders
// alongside the one-time SQL backfill for rows that don't get an update any time soon).
const KNOWN_SECONDARY_BRANDS: Array<{ match: RegExp; brandName: string }> = [{ match: /ziro\s*kart/i, brandName: "Ziro kart" }];
const DEFAULT_BRAND_NAME = "Leafy Dew";

function resolveBrandForListing(sku: string | null | undefined, productName: string | null | undefined): string {
  const haystack = `${sku ?? ""} ${productName ?? ""}`;
  for (const candidate of KNOWN_SECONDARY_BRANDS) {
    if (candidate.match.test(haystack)) return candidate.brandName;
  }
  return DEFAULT_BRAND_NAME;
}

async function upsertProductPassportsFromListings(sellerId: string, listings: ListingSyncItem[]): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  for (const listing of listings) {
    const existing = await findProductPassportForListing(sellerId, listing);
    const status = listingLooksActive(listing.listingStatus) ? "ACTIVE" : "NEEDS_REVIEW";
    const resolvedBrand = resolveBrandForListing(listing.sku, listing.productName);

    if (existing) {
      const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (!existing.sku && listing.sku) updateRow.sku = listing.sku;
      // ASIN: always refresh from Amazon's current listings report, the same way
      // product_name/product_type/price/status/brand already do below. This used to only
      // backfill the ASIN when the stored value was empty, which let a Product Passport's
      // ASIN go stale forever once set. findProductPassportForListing() matches this row by
      // SKU, and Amazon does sometimes attach a new ASIN to an existing SKU over time (a
      // relist or catalog merge) — so this SKU's own passport row should track whichever
      // ASIN Amazon currently reports as live for it, not whichever ASIN happened to be
      // captured the first time this SKU was synced. (First surfaced on SKU DV-R5TL-79KT:
      // the passport stayed stuck on ASIN B0HFWSFSL1 while Amazon's own listing had already
      // moved on to B0HJJJ5DN3, and every daily sync kept silently failing to notice.)
      if (listing.asin && existing.asin !== listing.asin) updateRow.asin = listing.asin;
      // Always refresh these from Amazon's current listings report — this runs
      // automatically in the background now, so a founder never clicks a button to
      // "confirm" it's really time to trust Amazon's data. Only skip overwriting a
      // manually-set product name if Amazon's report doesn't have one at all.
      if (listing.productName) updateRow.product_name = listing.productName;
      if (listing.productType) {
        updateRow.product_type = listing.productType;
        updateRow.category = listing.productType;
      }
      if (listing.price !== null && listing.price !== undefined) updateRow.selling_price = listing.price;
      if (existing.status === "DRAFT" || existing.status !== status) updateRow.status = status;
      // Self-heal a mislabeled brand from the old hardcoded-"Leafy Dew" bug, or fill it in if
      // it was ever left blank. Never overwrites a brand a founder may have manually corrected
      // to something outside the known set (only corrects towards a brand we can detect).
      if (existing.brand !== resolvedBrand && (!existing.brand || KNOWN_SECONDARY_BRANDS.some((b) => b.brandName === resolvedBrand))) {
        updateRow.brand = resolvedBrand;
      }

      if (Object.keys(updateRow).length > 1) {
        const { error } = await supabase.from("product_passports").update(updateRow).eq("id", existing.id);
        if (error) logSafeAmazonSpError("Could not update product passport from Amazon listing.", error);
        else updated += 1;
      }
      continue;
    }

    const { error } = await supabase.from("product_passports").insert({
      seller_id: sellerId,
      sku: listing.sku,
      asin: listing.asin,
      product_name: listing.productName ?? listing.sku,
      brand: resolvedBrand,
      category: listing.productType,
      product_type: listing.productType,
      selling_price: listing.price,
      status
    });

    if (error) {
      logSafeAmazonSpError("Could not create product passport from Amazon listing.", error);
    } else {
      inserted += 1;
    }
  }

  return { inserted, updated };
}

export async function requireConnectedConnection(sellerId: string): Promise<AmazonSpConnectionRow> {
  const connection = await getConnection(sellerId);

  if (connection && (connection.token_status === "CONNECTED" || env.SP_API_REFRESH_TOKEN)) {
    const resolvedAmazonSellerId = cleanText(env.SP_API_AMAZON_SELLER_ID) ?? cleanText(connection.amazon_seller_id) ?? connection.amazon_seller_id;
    return {
      ...connection,
      amazon_seller_id: resolvedAmazonSellerId
    };
  }

  if (env.SP_API_REFRESH_TOKEN) {
    const now = new Date().toISOString();

    return {
      id: AMAZON_SP_ENV_CONNECTION_ID,
      seller_id: sellerId,
      amazon_seller_id: cleanText(env.SP_API_AMAZON_SELLER_ID),
      marketplace_id: getAmazonSpMarketplaceId(),
      region: getAmazonSpRegion(),
      refresh_token_encrypted: null,
      token_status: "CONNECTED_ENV",
      last_connected_at: null,
      last_error: null,
      created_at: now,
      updated_at: now
    };
  }

  throw new Error("SP-API refresh token is not configured.");
}

type AmazonSpAttributeValue = Record<string, unknown>;
type AmazonSpAttributesMap = Record<string, AmazonSpAttributeValue[] | undefined>;

function firstAttributeValue(attributes: AmazonSpAttributesMap | undefined, keys: string[]): AmazonSpAttributeValue | undefined {
  if (!attributes) return undefined;
  for (const key of keys) {
    const entries = attributes[key];
    if (Array.isArray(entries) && entries.length > 0 && entries[0] && typeof entries[0] === "object") {
      return entries[0];
    }
  }
  return undefined;
}

function readAttrText(entry: AmazonSpAttributeValue | undefined, keys: string[] = ["value"]): string | null {
  if (!entry) return null;
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function formatDimensionEntry(entry: AmazonSpAttributeValue | undefined): string | null {
  if (!entry || typeof entry !== "object") return null;

  const readMeasure = (field: string): { value: number; unit: string } | null => {
    const raw = entry[field];
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const value = typeof record.value === "number" ? record.value : Number(record.value);
    const unit = typeof record.unit === "string" ? record.unit : "";
    if (!Number.isFinite(value)) return null;
    return { value, unit };
  };

  const length = readMeasure("length");
  const width = readMeasure("width");
  const height = readMeasure("height");

  if (!length && !width && !height) return null;

  const parts = [length, width, height].filter((part): part is { value: number; unit: string } => part !== null);
  if (parts.length === 0) return null;

  const unit = parts[0].unit || "";
  const numbers = parts.map((part) => trimTrailingZeros(part.value)).join(" x ");
  return unit ? `${numbers} ${unit}` : numbers;
}

function formatWeightEntry(entry: AmazonSpAttributeValue | undefined): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const value = typeof record.value === "number" ? record.value : Number(record.value);
  const unit = typeof record.unit === "string" ? record.unit : "";
  if (!Number.isFinite(value)) return null;
  return unit ? `${trimTrailingZeros(value)} ${unit}` : trimTrailingZeros(value);
}

function trimTrailingZeros(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatSingleMeasureEntry(entry: AmazonSpAttributeValue | undefined): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const value = typeof record.value === "number" ? record.value : Number(record.value);
  const unit = typeof record.unit === "string" ? record.unit : "";
  if (!Number.isFinite(value)) return null;
  return unit ? `${trimTrailingZeros(value)} ${unit}` : trimTrailingZeros(value);
}

function extractPhysicalAttributes(attributes: AmazonSpAttributesMap | undefined): {
  dimensions: string | null;
  weight: string | null;
  material: string | null;
  color: string | null;
} {
  const dimensionsEntry = firstAttributeValue(attributes, [
    "item_dimensions", "package_dimensions", "item_package_dimensions",
    "item_display_dimensions", "item_pallet_dimensions",
    "item_length_width_height", "item_depth_width_height"
  ]);
  const weightEntry = firstAttributeValue(attributes, [
    "item_weight", "item_package_weight", "package_weight", "item_display_weight"
  ]);
  const diameterEntry = firstAttributeValue(attributes, ["item_diameter"]);
  const colorEntry = firstAttributeValue(attributes, ["color", "color_name", "colour", "color_map"]);
  const materialEntry = firstAttributeValue(attributes, [
    "material_type", "material", "fabric_type", "outer_material_type", "cushion_material_type"
  ]);

  const dimensions = formatDimensionEntry(dimensionsEntry) ??
    (diameterEntry ? (() => {
      const diameterText = formatSingleMeasureEntry(diameterEntry);
      return diameterText ? `${diameterText} diameter` : null;
    })() : null);

  return {
    dimensions,
    weight: formatWeightEntry(weightEntry),
    color: readAttrText(colorEntry, ["value"]),
    material: readAttrText(materialEntry, ["value"])
  };
}

function extractBulletPoints(attributes: AmazonSpAttributesMap | undefined): string[] {
  if (!attributes) return [];
  const entries = attributes["bullet_point"];
  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => readAttrText(entry, ["value"]))
    .filter((value): value is string => Boolean(value));
}

function extractImageUrls(attributes: AmazonSpAttributesMap | undefined): string[] {
  if (!attributes) return [];

  const locatorKeys = [
    "main_product_image_locator",
    "other_product_image_locator_1",
    "other_product_image_locator_2",
    "other_product_image_locator_3",
    "other_product_image_locator_4",
    "other_product_image_locator_5",
    "other_product_image_locator_6",
    "other_product_image_locator_7",
    "other_product_image_locator_8"
  ];

  const urls: string[] = [];
  for (const key of locatorKeys) {
    const entry = firstAttributeValue(attributes, [key]);
    const url = readAttrText(entry, ["media_location", "value", "url"]);
    if (url) urls.push(url);
  }

  return urls;
}

type AmazonSpImagesResponse = Array<{
  marketplaceId?: string;
  images?: Array<{ variant?: string; link?: string }>;
}>;

function extractImageUrlsFromImagesField(imagesResponse: AmazonSpImagesResponse | undefined, marketplaceId: string): string[] {
  if (!Array.isArray(imagesResponse) || imagesResponse.length === 0) return [];

  const marketplaceEntry = imagesResponse.find((entry) => entry.marketplaceId === marketplaceId) ?? imagesResponse[0];
  const images = Array.isArray(marketplaceEntry?.images) ? marketplaceEntry.images : [];

  const variantOrder = (variant: string | undefined): number => {
    if (variant === "MAIN") return 0;
    const match = /^PT(\d+)$/.exec(variant ?? "");
    return match ? Number(match[1]) : 99;
  };

  return images
    .slice()
    .sort((a, b) => variantOrder(a.variant) - variantOrder(b.variant))
    .map((image) => image.link)
    .filter((link): link is string => typeof link === "string" && link.trim().length > 0);
}

export async function syncAmazonSpListingAttributes(input: { sellerId: string; limit?: number }) {
  const sellerId = sellerIdOrDefault(input.sellerId);
  const limit = Math.min(Math.max(toIntegerOrNull(input.limit ?? undefined) ?? 25, 1), 100);
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);
  const amazonSellerId = connection.amazon_seller_id;

  if (!amazonSellerId) {
    throw new Error("Amazon seller ID is not available on this connection yet. Run the status/doctor check first.");
  }

  await logSpActivity({
    sellerId,
    action: "SYNC_LISTING_ATTRIBUTES_STARTED",
    status: "INFO",
    message: "Amazon SP-API listing attribute sync started."
  });

  const { count: totalEligible } = await supabase
    .from("product_passports")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .not("sku", "is", null);

  const { data: rows, error: selectError } = await supabase
    .from("product_passports")
    .select("id, sku, dimensions, weight, material, color, key_features, image_urls, category")
    .eq("seller_id", sellerId)
    .not("sku", "is", null)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (selectError) {
    throw new Error(safeErrorMessage(selectError));
  }

  const candidates = rows ?? [];
  let updatedCount = 0;
  let skippedCount = 0;
  const warnings: string[] = [];
  const seenAttributeKeys = new Set<string>();
  let noUpdateDiagnosticsShown = 0;

  for (const row of candidates) {
    try {
      const response = await amazonSpGet<{
        attributes?: AmazonSpAttributesMap;
        summaries?: Array<{ productType?: string }>;
        images?: AmazonSpImagesResponse;
      }>({
        path: `/listings/2021-08-01/items/${amazonSellerId}/${encodeURIComponent(row.sku)}`,
        query: {
          marketplaceIds: [connection.marketplace_id],
          includedData: ["attributes", "summaries", "images"]
        },
        accessToken,
        region: connection.region,
        stage: "GET_LISTINGS_ITEM"
      });

      const attributeKeys = response?.attributes ? Object.keys(response.attributes) : [];
      attributeKeys.forEach((key) => seenAttributeKeys.add(key));

      const extracted = extractPhysicalAttributes(response?.attributes);
      const extractedBullets = extractBulletPoints(response?.attributes);
      const imagesFromImagesField = extractImageUrlsFromImagesField(response?.images, connection.marketplace_id);
      const extractedImages = imagesFromImagesField.length > 0 ? imagesFromImagesField : extractImageUrls(response?.attributes);
      const extractedProductType = response?.summaries?.[0]?.productType || null;
      const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (extractedProductType) updateRow.product_type = extractedProductType;
      // Backfill the Brand Readiness "category" field from this same, already-fetched real
      // Amazon product type whenever it's still empty. Found 2026-09-23: this sync has always
      // set product_type from Amazon's real data (161/182 products already had it), but never
      // copied that same real value into the separate "category" field Brand Readiness actually
      // scores — so brandConsistency sat at 6% category coverage despite the real data already
      // being on file. Only fills a gap, never overwrites a category a founder (or the older
      // flat-file sync path) already set, so existing human-readable values like "Home Decor
      // Products" are left exactly as they are.
      if (extractedProductType && !row.category) updateRow.category = extractedProductType;

      // This sync is an explicit, manually-triggered action ("Sync from Amazon"), so it
      // always refreshes with Amazon's current data rather than only filling blanks —
      // otherwise a founder who later edits the real Amazon listing would keep seeing
      // stale first-synced values here forever.
      if (extracted.dimensions) updateRow.dimensions = extracted.dimensions;
      if (extracted.weight) updateRow.weight = extracted.weight;
      if (extracted.material) updateRow.material = extracted.material;
      if (extracted.color) updateRow.color = extracted.color;
      if (extractedBullets.length > 0) {
        updateRow.key_features = extractedBullets;
      }
      if (extractedImages.length > 0) {
        updateRow.image_urls = extractedImages;
      }

      if (Object.keys(updateRow).length > 1) {
        const { error: updateError } = await supabase.from("product_passports").update(updateRow).eq("id", row.id);
        if (updateError) {
          logSafeAmazonSpError("Could not save Amazon listing attributes to product passport.", updateError);
          warnings.push(`SKU ${row.sku}: fetched attributes but could not save them.`);
        } else {
          updatedCount += 1;
        }
      } else {
        skippedCount += 1;
        if (noUpdateDiagnosticsShown < 5) {
          noUpdateDiagnosticsShown += 1;
          const ownKeys = attributeKeys.slice().sort().join(", ") || "(no attributes at all)";
          const rawBulletPoint = response?.attributes?.["bullet_point"];
          const rawMainImage = response?.attributes?.["main_product_image_locator"];
          warnings.push(
            `SKU ${row.sku}: this product's own attribute keys: ${ownKeys}. ` +
            `bullet_point raw: ${rawBulletPoint ? JSON.stringify(rawBulletPoint).slice(0, 300) : "(missing)"}. ` +
            `main_product_image_locator raw: ${rawMainImage ? JSON.stringify(rawMainImage).slice(0, 300) : "(missing)"}. ` +
            `EXTRACTED bullets count=${extractedBullets.length}, images count=${extractedImages.length}. ` +
            `CURRENT DB key_features=${JSON.stringify(row.key_features)}, image_urls=${JSON.stringify(row.image_urls)}.`
          );
        }
      }
    } catch (itemError) {
      skippedCount += 1;
      const details = safeErrorDetails(itemError);
      if (typeof details === "string") {
        warnings.push(`SKU ${row.sku}: ${details}`);
      } else {
        const reason = details.amazonErrorMessage || details.amazonErrorCode || `HTTP ${details.httpStatus}`;
        const queryDump = details.safeQuery ? JSON.stringify(details.safeQuery) : "(none)";
        warnings.push(
          `SKU ${row.sku}: Amazon said "${reason}"${details.amazonErrorCode ? ` (${details.amazonErrorCode})` : ""}. Request sent: ${details.method} ${details.path} query=${queryDump}`
        );
      }
    }

    await smallDelay(400);
  }

  if (updatedCount === 0 && candidates.length > 0) {
    const keyList = Array.from(seenAttributeKeys).sort().join(", ");
    warnings.unshift(
      keyList
        ? `Diagnostic: Amazon returned these attribute names for your products, none matched what we look for: ${keyList}`
        : "Diagnostic: Amazon returned no attributes object at all for these SKUs."
    );
  }

  await logSpActivity({
    sellerId,
    action: "SYNC_LISTING_ATTRIBUTES_COMPLETED",
    status: "SUCCESS",
    message: "Amazon SP-API listing attribute sync completed.",
    metadata: { checked: candidates.length, updatedCount, skippedCount, seenAttributeKeys: Array.from(seenAttributeKeys) }
  });

  return {
    ok: true,
    checked: candidates.length,
    updatedCount,
    skippedCount,
    totalEligible: totalEligible ?? candidates.length,
    warnings
  };
}

async function updateConnectionError(connectionId: string, lastError: string | null): Promise<void> {
  if (connectionId === AMAZON_SP_ENV_CONNECTION_ID) {
    return;
  }

  const { error } = await supabase
    .from("amazon_sp_connections")
    .update({
      last_error: lastError,
      updated_at: new Date().toISOString()
    })
    .eq("id", connectionId);

  if (error) logSafeAmazonSpError("Could not update Amazon SP-API connection status.", error);
}

export async function listAmazonSpListings(sellerIdInput: string, limit: number): Promise<SafeAmazonSpListing[]> {
  const { data, error } = await supabase
    .from("amazon_sp_listings")
    .select("*")
    .eq("seller_id", sellerIdOrDefault(sellerIdInput))
    .order("last_synced_at", { ascending: false })
    .limit(limit);

  if (error) {
    logSafeAmazonSpError("Could not list Amazon SP-API listings.", error);
    throw new Error("Could not load Amazon SP-API listings from Supabase.");
  }

  return ((data ?? []) as AmazonSpListingRow[]).map(toSafeListing);
}

function extractOrders(response: unknown): { orders: OrderSyncItem[]; nextToken?: string } {
  const payload = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const rawOrders = Array.isArray(payload.Orders) ? payload.Orders : [];
  return {
    nextToken: typeof payload.NextToken === "string" ? payload.NextToken : undefined,
    orders: rawOrders
      .filter((order): order is Record<string, unknown> => Boolean(order) && typeof order === "object")
      .map((order) => {
        const total = order.OrderTotal && typeof order.OrderTotal === "object" ? order.OrderTotal as Record<string, unknown> : {};
        return {
          amazonOrderId: String(order.AmazonOrderId ?? ""),
          purchaseDate: cleanText(String(order.PurchaseDate ?? "")),
          orderStatus: cleanText(String(order.OrderStatus ?? "")),
          fulfillmentChannel: cleanText(String(order.FulfillmentChannel ?? "")),
          salesChannel: cleanText(String(order.SalesChannel ?? "")),
          orderTotalAmount: toNumberOrNull(total.Amount),
          orderTotalCurrency: cleanText(String(total.CurrencyCode ?? "")),
          numberOfItemsShipped: toIntegerOrNull(order.NumberOfItemsShipped),
          numberOfItemsUnshipped: toIntegerOrNull(order.NumberOfItemsUnshipped),
          rawPayload: order
        };
      })
      .filter((order) => order.amazonOrderId.length > 0)
  };
}

function extractOrderItems(amazonOrderId: string, response: unknown): { items: OrderItemSyncItem[]; nextToken?: string } {
  const payload = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const rawItems = Array.isArray(payload.OrderItems) ? payload.OrderItems : [];
  return {
    nextToken: typeof payload.NextToken === "string" ? payload.NextToken : undefined,
    items: rawItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => {
        const price = item.ItemPrice && typeof item.ItemPrice === "object" ? item.ItemPrice as Record<string, unknown> : {};
        const tax = item.ItemTax && typeof item.ItemTax === "object" ? item.ItemTax as Record<string, unknown> : {};
        const discount = item.PromotionDiscount && typeof item.PromotionDiscount === "object" ? item.PromotionDiscount as Record<string, unknown> : {};
        return {
          amazonOrderId,
          orderItemId: String(item.OrderItemId ?? ""),
          asin: cleanText(String(item.ASIN ?? "")),
          sku: cleanText(String(item.SellerSKU ?? "")),
          title: cleanText(String(item.Title ?? "")),
          quantityOrdered: toIntegerOrNull(item.QuantityOrdered),
          quantityShipped: toIntegerOrNull(item.QuantityShipped),
          itemPriceAmount: toNumberOrNull(price.Amount),
          itemPriceCurrency: cleanText(String(price.CurrencyCode ?? "")),
          itemTaxAmount: toNumberOrNull(tax.Amount),
          promotionDiscountAmount: toNumberOrNull(discount.Amount),
          rawPayload: item
        };
      })
      .filter((item) => item.orderItemId.length > 0)
  };
}

async function getOrderReportStatus(
  accessToken: string,
  region: AmazonSpConnectionRow["region"],
  reportId: string
): Promise<AmazonSpReportResponse> {
  return amazonSpGet<AmazonSpReportResponse>({
    path: `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
    accessToken,
    region,
    stage: "GET_ORDER_REPORT"
  });
}

async function createOrderReport(input: {
  accessToken: string;
  region: AmazonSpConnectionRow["region"];
  marketplaceId: string;
  days: number;
  reportType: string;
  dataStartTime?: string;
  dataEndTime?: string;
}): Promise<string> {
  const now = Date.now();
  const response = await amazonSpPost<AmazonSpReportResponse>({
    path: "/reports/2021-06-30/reports",
    accessToken: input.accessToken,
    region: input.region,
    stage: "CREATE_ORDER_REPORT",
    body: {
      reportType: input.reportType,
      marketplaceIds: [input.marketplaceId],
      dataStartTime: input.dataStartTime ?? new Date(now - input.days * 24 * 60 * 60 * 1000).toISOString(),
      dataEndTime: input.dataEndTime ?? new Date(now - 2 * 60 * 1000).toISOString()
    }
  });

  if (!response.reportId) {
    throw new Error("Amazon did not return an order report id.");
  }

  return response.reportId;
}

async function waitForOrderReport(input: {
  accessToken: string;
  region: AmazonSpConnectionRow["region"];
  marketplaceId: string;
  days: number;
  reportType: string;
  reportId?: string;
}): Promise<{ reportId: string; report: AmazonSpReportResponse }> {
  const reportId = input.reportId ?? await createOrderReport({
    accessToken: input.accessToken,
    region: input.region,
    marketplaceId: input.marketplaceId,
    days: input.days,
    reportType: input.reportType
  });

  if (input.reportId) {
    return {
      reportId,
      report: await getOrderReportStatus(input.accessToken, input.region, reportId)
    };
  }

  let report: AmazonSpReportResponse = { reportId, processingStatus: "IN_QUEUE" };

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    report = await getOrderReportStatus(input.accessToken, input.region, reportId);
    const status = report.processingStatus ?? "UNKNOWN";
    if (ORDER_REPORT_STOP_STATUSES.has(status)) {
      break;
    }

    if (attempt < 6) {
      await smallDelay(10000);
    }
  }

  return { reportId, report };
}

function parseOrderReportText(text: string): OrderReportParsedResult {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const lines = withoutBom
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { orders: [], orderItems: [], skippedCount: 0, totalSales: 0, totalUnits: 0 };
  }

  const headers = splitTabDelimitedLine(lines[0]).map((header) => header.trim().toLowerCase());
  const orderItems: OrderItemSyncItem[] = [];
  const ordersById = new Map<string, OrderSyncItem>();
  let skippedCount = 0;

  for (const [rowOffset, line] of lines.slice(1).entries()) {
    const rowIndex = rowOffset + 1;
    const cells = splitTabDelimitedLine(line);
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });

    if (Object.values(row).every((value) => value.length === 0)) {
      continue;
    }

    const amazonOrderId = amazonOrderIdFromReportRow(row);

    if (!amazonOrderId) {
      skippedCount += 1;
      continue;
    }

    const sku = reportValue(row, ["sku"]);
    const orderItemId = orderItemIdFromReportRow(row, amazonOrderId, rowIndex);

    if (!orderItemId) {
      skippedCount += 1;
      continue;
    }

    const purchaseDate = reportValue(row, ["purchase-date", "last-updated-date"]);
    const paymentsDate = reportValue(row, ["payments-date"]);
    const orderStatus = reportValue(row, ["order-status"]);
    const fulfillmentChannel = reportValue(row, ["fulfillment-channel", "fulfilled-by"]);
    const salesChannel = reportValue(row, ["sales-channel"]);
    const quantityOrdered = toIntegerOrNull(reportValue(row, ["quantity", "quantity-purchased"])) ?? 0;
    const itemPriceAmount = reportNumber(row, ["item-price", "item-price-amount"]);
    const itemTaxAmount = reportNumber(row, ["item-tax"]);
    const promotionDiscountAmount = reportNumber(row, ["item-promotion-discount", "promotion-discount"]);
    const asin = reportValue(row, ["asin"]);
    const title = reportValue(row, ["product-name", "item-name", "title"]);
    const currency = reportValue(row, ["currency"]) ?? "INR";
    // Amazon's general order report includes the ship-to region (city/state/
    // postal/country) without needing the separate restricted-PII grant that
    // buyer name and street address require. This is order-level, not
    // item-level, so it only needs capturing once per order below.
    const shipCity = reportValue(row, ["ship-city"]);
    const shipState = reportValue(row, ["ship-state"]);
    const shipPostalCode = reportValue(row, ["ship-postal-code"]);
    const shipCountry = reportValue(row, ["ship-country"]);

    const sanitizedItemPayload = {
      amazon_order_id: amazonOrderId,
      order_item_id: orderItemId,
      purchase_date: purchaseDate,
      sku,
      asin,
      title,
      quantity: quantityOrdered,
      currency,
      item_price_amount: itemPriceAmount,
      item_tax_amount: itemTaxAmount,
      promotion_discount_amount: promotionDiscountAmount,
      order_status: orderStatus,
      fulfillment_channel: fulfillmentChannel,
      sales_channel: salesChannel
    };

    orderItems.push({
      amazonOrderId,
      orderItemId,
      asin,
      sku,
      title,
      quantityOrdered,
      quantityShipped: quantityOrdered,
      itemPriceAmount,
      itemPriceCurrency: currency,
      itemTaxAmount,
      promotionDiscountAmount,
      rawPayload: sanitizedItemPayload
    });

    const existingOrder = ordersById.get(amazonOrderId) ?? {
      amazonOrderId,
      purchaseDate,
      orderStatus,
      fulfillmentChannel,
      salesChannel,
      orderTotalAmount: 0,
      orderTotalCurrency: currency,
      numberOfItemsShipped: 0,
      numberOfItemsUnshipped: null,
      rawPayload: {
        amazonOrderId,
        purchaseDate,
        paymentsDate,
        orderStatus,
        fulfillmentChannel,
        salesChannel,
        currency,
        shipCity,
        shipState,
        shipPostalCode,
        shipCountry,
        itemCount: 0
      }
    };

    existingOrder.orderTotalAmount = (existingOrder.orderTotalAmount ?? 0) + (itemPriceAmount ?? 0);
    existingOrder.numberOfItemsShipped = (existingOrder.numberOfItemsShipped ?? 0) + quantityOrdered;
    existingOrder.purchaseDate = existingOrder.purchaseDate ?? purchaseDate;
    existingOrder.orderStatus = existingOrder.orderStatus ?? orderStatus;
    existingOrder.fulfillmentChannel = existingOrder.fulfillmentChannel ?? fulfillmentChannel;
    existingOrder.salesChannel = existingOrder.salesChannel ?? salesChannel;
    existingOrder.orderTotalCurrency = existingOrder.orderTotalCurrency ?? currency;
    existingOrder.rawPayload = {
      ...(existingOrder.rawPayload ?? {}),
      itemCount: ((existingOrder.rawPayload as Record<string, unknown> | null)?.itemCount as number | undefined ?? 0) + 1
    };
    ordersById.set(amazonOrderId, existingOrder);
  }

  const totalSales = orderItems.reduce((sum, item) => sum + (item.itemPriceAmount ?? 0), 0);
  const totalUnits = orderItems.reduce((sum, item) => sum + (item.quantityOrdered ?? 0), 0);

  return {
    orders: Array.from(ordersById.values()),
    orderItems,
    skippedCount,
    totalSales,
    totalUnits
  };
}

function isPiiReportHeader(header: string): boolean {
  const normalized = header.toLowerCase();
  return (
    normalized.includes("buyer") ||
    normalized.includes("email") ||
    normalized.includes("phone") ||
    normalized.includes("address") ||
    normalized.includes("recipient") ||
    normalized.includes("billing") ||
    normalized.includes("ship-to")
  );
}

function safeReportHeaders(headers: string[]): string[] {
  return headers.map((header) => isPiiReportHeader(header) ? "[PII_HEADER_REDACTED]" : header);
}

function hasNumericParseIssue(row: Record<string, string>): boolean {
  const checks: Array<[string[], (value: unknown) => number | null]> = [
    [["quantity", "quantity-purchased"], toIntegerOrNull],
    [["item-price", "item-price-amount"], (value) => reportNumber({ value: String(value ?? "") }, ["value"])],
    [["item-tax"], (value) => reportNumber({ value: String(value ?? "") }, ["value"])],
    [["item-promotion-discount", "promotion-discount"], (value) => reportNumber({ value: String(value ?? "") }, ["value"])]
  ];

  return checks.some(([names, parser]) => {
    const rawValue = reportValue(row, names);
    return rawValue !== null && parser(rawValue) === null;
  });
}

function debugOrderReportText(text: string) {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const rawLines = withoutBom.split(/\r?\n/);
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === ""
    ? rawLines.slice(0, -1)
    : rawLines;
  const headerLine = lines[0] ?? "";
  const headers = headerLine ? splitTabDelimitedLine(headerLine).map((header) => header.trim().toLowerCase()) : [];
  const firstSafeRows: Array<{
    hasOrderId: boolean;
    hasOrderItemId: boolean;
    sku: string | null;
    asin: string | null;
    titlePresent: boolean;
    quantity: number | null;
    itemPrice: number | null;
    purchaseDatePresent: boolean;
    fulfillmentChannel: string | null;
    orderStatus: string | null;
  }> = [];
  const orderIds = new Set<string>();
  let blankRowCount = 0;
  let dataRowCount = 0;
  let mappedOrderItemRows = 0;
  let missingOrderIdRows = 0;
  let missingOrderItemIdRows = 0;
  let missingSkuRows = 0;
  let numericParseIssueRows = 0;

  for (const [rowOffset, line] of lines.slice(1).entries()) {
    const rowIndex = rowOffset + 1;
    if (line.trim().length === 0) {
      blankRowCount += 1;
      continue;
    }

    dataRowCount += 1;
    const cells = splitTabDelimitedLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });

    const amazonOrderId = amazonOrderIdFromReportRow(row);
    const orderItemId = amazonOrderId ? orderItemIdFromReportRow(row, amazonOrderId, rowIndex) : reportValue(row, ["order-item-id"]);
    const sku = reportValue(row, ["sku"]);
    const asin = reportValue(row, ["asin"]);
    const title = reportValue(row, ["product-name", "item-name", "title"]);
    const quantity = toIntegerOrNull(reportValue(row, ["quantity", "quantity-purchased"]));
    const itemPrice = reportNumber(row, ["item-price", "item-price-amount"]);
    const purchaseDate = reportValue(row, ["purchase-date", "last-updated-date"]);
    const fulfillmentChannel = reportValue(row, ["fulfillment-channel", "fulfilled-by"]);
    const orderStatus = reportValue(row, ["order-status"]);

    if (!amazonOrderId) missingOrderIdRows += 1;
    else orderIds.add(amazonOrderId);

    if (!orderItemId) missingOrderItemIdRows += 1;
    if (!sku) missingSkuRows += 1;
    if (amazonOrderId && orderItemId) mappedOrderItemRows += 1;
    if (hasNumericParseIssue(row)) numericParseIssueRows += 1;

    if (firstSafeRows.length < 3) {
      firstSafeRows.push({
        hasOrderId: Boolean(amazonOrderId),
        hasOrderItemId: Boolean(orderItemId),
        sku,
        asin,
        titlePresent: Boolean(title),
        quantity,
        itemPrice,
        purchaseDatePresent: Boolean(purchaseDate),
        fulfillmentChannel,
        orderStatus
      });
    }
  }

  const mappedOrderRows = orderIds.size;
  const diagnosis: OrderReportDiagnosis = dataRowCount === 0
    ? "REPORT_HAS_NO_DATA_ROWS"
    : mappedOrderRows > 0 && mappedOrderItemRows > 0
      ? "REPORT_HAS_ROWS_AND_MAPPING_WORKS"
      : "REPORT_HAS_ROWS_BUT_MAPPING_FAILED";

  return {
    rawTextLength: text.length,
    lineCount: lines.length,
    headerCount: headers.length,
    headers: safeReportHeaders(headers),
    dataRowCount,
    blankRowCount,
    mappedOrderRows,
    mappedOrderItemRows,
    missingOrderIdRows,
    missingOrderItemIdRows,
    missingSkuRows,
    numericParseIssueRows,
    firstSafeRows,
    diagnosis
  };
}

function orderReportTypeFromDebugMode(mode?: string): string {
  return mode === "LAST_UPDATE" ? ORDERS_REPORT_LAST_UPDATE_TYPE : ORDERS_REPORT_TYPE;
}

export async function debugAmazonSpOrderReport(input: {
  sellerId: string;
  days: number;
  reportId?: string;
  reportTypeMode?: string;
}) {
  const sellerId = sellerIdOrDefault(input.sellerId);
  const days = Math.min(Math.max(Math.floor(input.days), 1), 90);
  const requestedReportId = cleanText(input.reportId) ?? undefined;
  const reportType = orderReportTypeFromDebugMode(input.reportTypeMode);
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);
  const { reportId, report } = await waitForOrderReport({
    accessToken,
    region: connection.region,
    marketplaceId: connection.marketplace_id,
    days,
    reportType,
    reportId: requestedReportId
  });
  const processingStatus = report.processingStatus ?? "UNKNOWN";

  if (ORDER_REPORT_PROCESSING_STATUSES.has(processingStatus)) {
    return {
      ok: true,
      reportId,
      processingStatus,
      reportType,
      rawTextLength: 0,
      lineCount: 0,
      headerCount: 0,
      headers: [],
      dataRowCount: 0,
      blankRowCount: 0,
      mappedOrderRows: 0,
      mappedOrderItemRows: 0,
      missingOrderIdRows: 0,
      missingOrderItemIdRows: 0,
      missingSkuRows: 0,
      numericParseIssueRows: 0,
      firstSafeRows: [],
      diagnosis: "REPORT_PROCESSING" satisfies OrderReportDiagnosis
    };
  }

  if (processingStatus === "CANCELLED" || processingStatus === "FATAL") {
    return {
      ok: true,
      reportId,
      processingStatus,
      reportType,
      rawTextLength: 0,
      lineCount: 0,
      headerCount: 0,
      headers: [],
      dataRowCount: 0,
      blankRowCount: 0,
      mappedOrderRows: 0,
      mappedOrderItemRows: 0,
      missingOrderIdRows: 0,
      missingOrderItemIdRows: 0,
      missingSkuRows: 0,
      numericParseIssueRows: 0,
      firstSafeRows: [],
      diagnosis: "REPORT_FAILED" satisfies OrderReportDiagnosis
    };
  }

  if (processingStatus === "DONE_NO_DATA") {
    return {
      ok: true,
      reportId,
      processingStatus,
      reportType,
      rawTextLength: 0,
      lineCount: 0,
      headerCount: 0,
      headers: [],
      dataRowCount: 0,
      blankRowCount: 0,
      mappedOrderRows: 0,
      mappedOrderItemRows: 0,
      missingOrderIdRows: 0,
      missingOrderItemIdRows: 0,
      missingSkuRows: 0,
      numericParseIssueRows: 0,
      firstSafeRows: [],
      diagnosis: "REPORT_HAS_NO_DATA_ROWS" satisfies OrderReportDiagnosis
    };
  }

  if (processingStatus !== "DONE" || !report.reportDocumentId) {
    return {
      ok: true,
      reportId,
      processingStatus,
      reportType,
      rawTextLength: 0,
      lineCount: 0,
      headerCount: 0,
      headers: [],
      dataRowCount: 0,
      blankRowCount: 0,
      mappedOrderRows: 0,
      mappedOrderItemRows: 0,
      missingOrderIdRows: 0,
      missingOrderItemIdRows: 0,
      missingSkuRows: 0,
      numericParseIssueRows: 0,
      firstSafeRows: [],
      diagnosis: "UNKNOWN" satisfies OrderReportDiagnosis
    };
  }

  const reportText = await loadAmazonSpReportDocument({
    accessToken,
    region: connection.region,
    reportDocumentId: report.reportDocumentId,
    stage: "GET_DEBUG_ORDER_REPORT_DOCUMENT"
  });

  return {
    ok: true,
    reportId,
    processingStatus,
    reportType,
    ...debugOrderReportText(reportText)
  };
}

export async function syncAmazonSpOrderReport(input: { sellerId: string; days: number; reportId?: string }) {
  const sellerId = sellerIdOrDefault(input.sellerId);
  const days = Math.min(Math.max(Math.floor(input.days), 1), 90);
  const requestedReportId = cleanText(input.reportId) ?? undefined;
  const connection = await requireConnectedConnection(sellerId);
  const warnings: string[] = [];

  await logSpActivity({
    sellerId,
    action: "SYNC_ORDER_REPORT_STARTED",
    status: "INFO",
    message: "Amazon SP-API order report sync started.",
    metadata: { source: "REPORTS_API", reportType: ORDERS_REPORT_TYPE, days }
  });

  try {
    const accessToken = await getAmazonSpAccessToken(connection.id);
    const { reportId, report } = await waitForOrderReport({
      accessToken,
      region: connection.region,
      marketplaceId: connection.marketplace_id,
      days,
      reportType: ORDERS_REPORT_TYPE,
      reportId: requestedReportId
    });
    const status = report.processingStatus ?? "UNKNOWN";

    if (ORDER_REPORT_PROCESSING_STATUSES.has(status)) {
      return {
        ok: true,
        source: "REPORTS_API",
        status: "PROCESSING",
        reportId,
        reportType: ORDERS_REPORT_TYPE,
        message: "Amazon order report is processing. Retry with this reportId in a few minutes."
      };
    }

    if (status === "CANCELLED" || status === "FATAL" || status === "DONE_NO_DATA") {
      await updateConnectionError(connection.id, null);
      await logSpActivity({
        sellerId,
        action: "SYNC_ORDER_REPORT_COMPLETED",
        status: status === "DONE_NO_DATA" ? "SUCCESS" : "WARNING",
        message: `Amazon order report finished with status ${status}.`,
        metadata: { source: "REPORTS_API", reportId, reportStatus: status, days }
      });

      return {
        ok: true,
        source: "REPORTS_API",
        reportType: ORDERS_REPORT_TYPE,
        reportId,
        status,
        days,
        syncedOrders: 0,
        syncedOrderItems: 0,
        totalSales: 0,
        totalUnits: 0,
        skippedCount: 0,
        warnings
      };
    }

    if (status !== "DONE" || !report.reportDocumentId) {
      throw new Error("Amazon order report did not finish with a downloadable document.");
    }

    const reportText = await loadAmazonSpReportDocument({
      accessToken,
      region: connection.region,
      reportDocumentId: report.reportDocumentId,
      stage: "GET_ORDER_REPORT_DOCUMENT"
    });
    const parsed = parseOrderReportText(reportText);

    await upsertOrders(sellerId, connection.marketplace_id, parsed.orders);
    const orderItemSaveResult = await upsertOrderItems(sellerId, parsed.orderItems, { throwOnFailure: false });

    if (orderItemSaveResult.failedOrderItems > 0) {
      await updateConnectionError(connection.id, "Could not save all Amazon SP-API order items in Supabase.");
      await logSpActivity({
        sellerId,
        action: "SYNC_ORDER_REPORT_SAVE_ITEMS_PARTIAL_FAILURE",
        status: "ERROR",
        message: "Could not save all Amazon SP-API order items in Supabase.",
        metadata: {
          source: "REPORTS_API",
          reportType: ORDERS_REPORT_TYPE,
          reportId,
          savedOrderItems: orderItemSaveResult.savedOrderItems,
          failedOrderItems: orderItemSaveResult.failedOrderItems
        }
      });

      return {
        ok: false,
        message: "Could not save all Amazon SP-API order items in Supabase.",
        stage: "SAVE_ORDER_ITEMS",
        savedOrderItems: orderItemSaveResult.savedOrderItems,
        failedOrderItems: orderItemSaveResult.failedOrderItems,
        dbErrorCode: orderItemSaveResult.dbErrorCode,
        dbErrorMessage: orderItemSaveResult.dbErrorMessage,
        dbErrorDetails: orderItemSaveResult.dbErrorDetails,
        failedRowsSafe: orderItemSaveResult.failedRowsSafe
      };
    }

    await updateConnectionError(connection.id, null);
    await logSpActivity({
      sellerId,
      action: "SYNC_ORDER_REPORT_COMPLETED",
      status: "SUCCESS",
      message: "Amazon SP-API order report sync completed.",
      metadata: {
        source: "REPORTS_API",
        reportType: ORDERS_REPORT_TYPE,
        reportId,
        days,
        syncedOrders: parsed.orders.length,
        syncedOrderItems: orderItemSaveResult.savedOrderItems,
        totalSales: parsed.totalSales,
        totalUnits: parsed.totalUnits,
        skippedCount: parsed.skippedCount
      }
    });

    return {
      ok: true,
      source: "REPORTS_API",
      reportType: ORDERS_REPORT_TYPE,
      reportId,
      days,
      syncedOrders: parsed.orders.length,
      syncedOrderItems: orderItemSaveResult.savedOrderItems,
      totalSales: parsed.totalSales,
      totalUnits: parsed.totalUnits,
      skippedCount: parsed.skippedCount,
      warnings
    };
  } catch (error) {
    await updateConnectionError(connection.id, safeErrorMessage(error));
    await logSpActivity({
      sellerId,
      action: "SYNC_ORDER_REPORT_FAILED",
      status: "ERROR",
      message: safeErrorMessage(error)
    });
    throw error;
  }
}

export async function syncAmazonSpOrders(sellerIdInput: string, daysInput: number) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const days = Math.min(Math.max(Math.floor(daysInput), 1), 30);
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);
  const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const warnings: string[] = [];
  let nextToken: string | undefined;
  const orders: OrderSyncItem[] = [];
  const orderItems: OrderItemSyncItem[] = [];

  await logSpActivity({ sellerId, action: "SYNC_ORDERS_STARTED", status: "INFO", message: "Amazon SP-API order sync started." });

  try {
    for (let page = 0; page < 5; page += 1) {
      const response = await amazonSpGet<unknown>({
        path: "/orders/v0/orders",
        accessToken,
        region: connection.region,
        query: nextToken
          ? { NextToken: nextToken }
          : { MarketplaceIds: connection.marketplace_id, CreatedAfter: createdAfter }
      });
      const parsed = extractOrders(response);
      orders.push(...parsed.orders);
      if (!parsed.nextToken) break;
      nextToken = parsed.nextToken;
    }

    await upsertOrders(sellerId, connection.marketplace_id, orders);

    for (const order of orders.filter((item) => item.orderStatus !== "Pending")) {
      let itemNextToken: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const response = await amazonSpGet<unknown>({
          path: `/orders/v0/orders/${encodeURIComponent(order.amazonOrderId)}/orderItems`,
          accessToken,
          region: connection.region,
          query: itemNextToken ? { NextToken: itemNextToken } : undefined
        });
        const parsed = extractOrderItems(order.amazonOrderId, response);
        orderItems.push(...parsed.items);
        if (!parsed.nextToken) break;
        itemNextToken = parsed.nextToken;
      }
    }

    await upsertOrderItems(sellerId, orderItems);
    await updateConnectionError(connection.id, null);
    await logSpActivity({
      sellerId,
      action: "SYNC_ORDERS_COMPLETED",
      status: "SUCCESS",
      message: "Amazon SP-API order sync completed.",
      metadata: { syncedOrders: orders.length, syncedOrderItems: orderItems.length, days }
    });

    return {
      syncedOrders: orders.length,
      syncedOrderItems: orderItems.length,
      days,
      warnings
    };
  } catch (error) {
    await updateConnectionError(connection.id, safeErrorMessage(error));
    await logSpActivity({
      sellerId,
      action: "SYNC_ORDERS_FAILED",
      status: "ERROR",
      message: safeErrorMessage(error)
    });
    throw error;
  }
}

export async function syncAmazonSpOrderReportChunked(input: { sellerId: string; days: number }) {
  const sellerId = sellerIdOrDefault(input.sellerId);
  const requestedDays = Math.min(Math.max(Math.floor(input.days), 1), 90);
  const chunkSizeDays = 30;

  if (requestedDays <= chunkSizeDays) {
    return {
      ok: true,
      source: "REPORTS_API",
      status: "SKIPPED",
      requestedDays,
      chunkSizeDays,
      chunks: [],
      message: "Use sync-order-report directly for 30 days or less.",
      nextStep: "Retry each reportId with /api/amazon-sp/sync-order-report?sellerId=default&reportId=REPORT_ID"
    };
  }

  const connection = await requireConnectedConnection(sellerId);

  await logSpActivity({
    sellerId,
    action: "SYNC_ORDER_REPORT_CHUNKED_STARTED",
    status: "INFO",
    message: "Amazon SP-API chunked order report creation started.",
    metadata: { source: "REPORTS_API", reportType: ORDERS_REPORT_TYPE, requestedDays, chunkSizeDays }
  });

  try {
    const accessToken = await getAmazonSpAccessToken(connection.id);
    const endMs = Date.now() - 2 * 60 * 1000;
    const startMs = endMs - requestedDays * 24 * 60 * 60 * 1000;
    const chunks: Array<{
      chunkNumber: number;
      dataStartTime: string;
      dataEndTime: string;
      reportId: string;
      status: "PROCESSING";
    }> = [];
    let chunkStartMs = startMs;
    let chunkNumber = 1;

    while (chunkStartMs < endMs) {
      const chunkEndMs = Math.min(chunkStartMs + chunkSizeDays * 24 * 60 * 60 * 1000, endMs);
      const dataStartTime = new Date(chunkStartMs).toISOString();
      const dataEndTime = new Date(chunkEndMs).toISOString();
      const reportId = await createOrderReport({
        accessToken,
        region: connection.region,
        marketplaceId: connection.marketplace_id,
        days: chunkSizeDays,
        reportType: ORDERS_REPORT_TYPE,
        dataStartTime,
        dataEndTime
      });

      chunks.push({
        chunkNumber,
        dataStartTime,
        dataEndTime,
        reportId,
        status: "PROCESSING"
      });

      chunkStartMs = chunkEndMs;
      chunkNumber += 1;
    }

    await updateConnectionError(connection.id, null);
    await logSpActivity({
      sellerId,
      action: "SYNC_ORDER_REPORT_CHUNKED_CREATED",
      status: "SUCCESS",
      message: "Amazon SP-API chunked order reports created.",
      metadata: { source: "REPORTS_API", requestedDays, chunkSizeDays, chunksCount: chunks.length }
    });

    return {
      ok: true,
      source: "REPORTS_API",
      status: "PROCESSING",
      requestedDays,
      chunkSizeDays,
      chunks,
      nextStep: "Retry each reportId with /api/amazon-sp/sync-order-report?sellerId=default&reportId=REPORT_ID"
    };
  } catch (error) {
    await updateConnectionError(connection.id, safeErrorMessage(error));
    await logSpActivity({
      sellerId,
      action: "SYNC_ORDER_REPORT_CHUNKED_FAILED",
      status: "ERROR",
      message: safeErrorMessage(error)
    });
    throw error;
  }
}

function toSafeReportJob(row: AmazonSpReportJobRow) {
  return {
    reportId: row.report_id,
    reportType: row.report_type,
    jobType: row.job_type,
    status: row.status,
    dataStartTime: row.data_start_time,
    dataEndTime: row.data_end_time,
    createdAt: row.created_at,
    processedAt: row.processed_at,
    errorMessage: row.error_message
  };
}

async function saveAmazonSpReportJob(input: {
  sellerId: string;
  marketplaceId: string;
  reportId: string;
  reportType: string;
  jobType: AmazonSpReportJobType;
  status: string;
  dataStartTime?: string | null;
  dataEndTime?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("amazon_sp_report_jobs").upsert(
    {
      seller_id: input.sellerId,
      marketplace_id: input.marketplaceId,
      report_id: input.reportId,
      report_type: input.reportType,
      job_type: input.jobType,
      status: input.status,
      data_start_time: input.dataStartTime ?? null,
      data_end_time: input.dataEndTime ?? null,
      error_message: null,
      updated_at: now
    },
    { onConflict: "report_id" }
  );

  if (error) {
    logSafeAmazonSpError("Could not save Amazon SP-API report job.", error);
    throw new Error("Could not save Amazon SP-API report job in Supabase.");
  }
}

async function updateAmazonSpReportJob(input: {
  reportId: string;
  status: string;
  processedAt?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("amazon_sp_report_jobs")
    .update({
      status: input.status,
      last_attempt_at: now,
      processed_at: input.processedAt,
      error_message: input.errorMessage ? sanitizeAmazonSpValue(input.errorMessage) : null,
      updated_at: now
    })
    .eq("report_id", input.reportId);

  if (error) {
    logSafeAmazonSpError("Could not update Amazon SP-API report job.", error);
    throw new Error("Could not update Amazon SP-API report job in Supabase.");
  }
}

export async function createDailyAmazonSpSyncJobs(sellerIdInput: string) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);
  const orderEndMs = Date.now() - 2 * 60 * 1000;
  // Widened from 30 to 90 days so ship-to address data (buyer city/state/
  // postal code, used for the repeat-customer signal and the order detail
  // sheet) keeps getting refreshed for older orders too, not just the most
  // recent month. Every daily run still re-pulls this whole window, so this
  // is a resync of the same recent history, just further back.
  const orderStartMs = orderEndMs - 90 * 24 * 60 * 60 * 1000;
  const orderDataStartTime = new Date(orderStartMs).toISOString();
  const orderDataEndTime = new Date(orderEndMs).toISOString();
  const listingReportId = await createListingsReport(accessToken, connection.region, connection.marketplace_id);
  const orderReportId = await createOrderReport({
    accessToken,
    region: connection.region,
    marketplaceId: connection.marketplace_id,
    days: 90,
    reportType: ORDERS_REPORT_TYPE,
    dataStartTime: orderDataStartTime,
    dataEndTime: orderDataEndTime
  });

  await saveAmazonSpReportJob({
    sellerId,
    marketplaceId: connection.marketplace_id,
    reportId: listingReportId,
    reportType: LISTINGS_REPORT_TYPE,
    jobType: "LISTINGS_IMPORT",
    status: "PROCESSING"
  });
  await saveAmazonSpReportJob({
    sellerId,
    marketplaceId: connection.marketplace_id,
    reportId: orderReportId,
    reportType: ORDERS_REPORT_TYPE,
    jobType: "ORDER_IMPORT",
    status: "PROCESSING",
    dataStartTime: orderDataStartTime,
    dataEndTime: orderDataEndTime
  });

  await logSpActivity({
    sellerId,
    action: "DAILY_SP_SYNC_JOBS_CREATED",
    status: "SUCCESS",
    message: "Amazon SP-API daily sync jobs created.",
    metadata: { createdJobs: 2 }
  });

  return {
    ok: true,
    createdJobs: [
      {
        reportId: listingReportId,
        reportType: LISTINGS_REPORT_TYPE,
        jobType: "LISTINGS_IMPORT",
        status: "PROCESSING"
      },
      {
        reportId: orderReportId,
        reportType: ORDERS_REPORT_TYPE,
        jobType: "ORDER_IMPORT",
        status: "PROCESSING"
      }
    ],
    message: "Amazon SP-API sync jobs created. Reports will be processed when ready."
  };
}

async function processDoneReportJob(input: {
  job: AmazonSpReportJobRow;
  report: AmazonSpReportResponse;
  accessToken: string;
  connection: AmazonSpConnectionRow;
}) {
  if (!input.report.reportDocumentId) {
    throw new Error("Amazon report is DONE but did not include a document id.");
  }

  const reportText = await loadAmazonSpReportDocument({
    accessToken: input.accessToken,
    region: input.connection.region,
    reportDocumentId: input.report.reportDocumentId,
    stage: input.job.job_type === "LISTINGS_IMPORT" ? "GET_JOB_LISTINGS_REPORT_DOCUMENT" : "GET_JOB_ORDER_REPORT_DOCUMENT"
  });

  if (input.job.job_type === "LISTINGS_IMPORT") {
    const parsed = parseListingReportText(reportText);
    await upsertAmazonSpListingRows({
      sellerId: input.job.seller_id,
      connection: input.connection,
      listings: parsed.listings
    });
    const { inserted, updated } = await upsertProductPassportsFromListings(input.job.seller_id, parsed.listings);

    return {
      syncedListings: parsed.listings.length,
      upsertedProductPassports: inserted + updated,
      skippedCount: parsed.skippedCount
    };
  }

  const parsed = parseOrderReportText(reportText);
  await upsertOrders(input.job.seller_id, input.job.marketplace_id, parsed.orders);
  const saveResult = await upsertOrderItems(input.job.seller_id, parsed.orderItems, { throwOnFailure: false });

  if (saveResult.failedOrderItems > 0) {
    throw new Error(`Could not save ${saveResult.failedOrderItems} Amazon SP-API order items in Supabase.`);
  }

  return {
    syncedOrders: parsed.orders.length,
    syncedOrderItems: saveResult.savedOrderItems,
    totalSales: parsed.totalSales,
    totalUnits: parsed.totalUnits,
    skippedCount: parsed.skippedCount
  };
}

export async function processAmazonSpReportJobs(input: { sellerId: string; limit: number }) {
  const sellerId = sellerIdOrDefault(input.sellerId);
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 20);
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);
  const { data, error } = await supabase
    .from("amazon_sp_report_jobs")
    .select("*")
    .eq("seller_id", sellerId)
    .in("status", ["PROCESSING", "IN_QUEUE", "IN_PROGRESS"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    logSafeAmazonSpError("Could not load Amazon SP-API report jobs.", error);
    throw new Error("Could not load Amazon SP-API report jobs from Supabase.");
  }

  let processed = 0;
  let stillProcessing = 0;
  let failed = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const job of (data ?? []) as AmazonSpReportJobRow[]) {
    try {
      const report = job.job_type === "LISTINGS_IMPORT"
        ? await getListingsReportStatus(accessToken, connection.region, job.report_id)
        : await getOrderReportStatus(accessToken, connection.region, job.report_id);
      const status = report.processingStatus ?? "UNKNOWN";

      if (LISTINGS_REPORT_PROCESSING_STATUSES.has(status) || ORDER_REPORT_PROCESSING_STATUSES.has(status)) {
        stillProcessing += 1;
        await updateAmazonSpReportJob({ reportId: job.report_id, status });
        results.push({ reportId: job.report_id, jobType: job.job_type, status });
        continue;
      }

      if (status === "DONE") {
        const details = await processDoneReportJob({ job, report, accessToken, connection });
        processed += 1;
        await updateAmazonSpReportJob({
          reportId: job.report_id,
          status: "DONE",
          processedAt: new Date().toISOString()
        });
        results.push({ reportId: job.report_id, jobType: job.job_type, status: "DONE", ...details });
        continue;
      }

      if (status === "CANCELLED" || status === "FATAL" || status === "DONE_NO_DATA") {
        failed += 1;
        await updateAmazonSpReportJob({
          reportId: job.report_id,
          status,
          processedAt: new Date().toISOString(),
          errorMessage: `Amazon report finished with status ${status}.`
        });
        results.push({ reportId: job.report_id, jobType: job.job_type, status });
        continue;
      }

      failed += 1;
      await updateAmazonSpReportJob({
        reportId: job.report_id,
        status,
        errorMessage: `Amazon report returned unexpected status ${status}.`
      });
      results.push({ reportId: job.report_id, jobType: job.job_type, status });
    } catch (error) {
      failed += 1;
      const message = safeErrorMessage(error);
      await updateAmazonSpReportJob({
        reportId: job.report_id,
        status: "FAILED",
        errorMessage: message
      });
      results.push({
        reportId: job.report_id,
        jobType: job.job_type,
        status: "FAILED",
        errorMessage: message,
        details: safeErrorDetails(error)
      });
    }
  }

  return {
    ok: true,
    processed,
    stillProcessing,
    failed,
    results
  };
}

export async function listAmazonSpReportJobs(sellerIdInput: string) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const { data, error } = await supabase
    .from("amazon_sp_report_jobs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    logSafeAmazonSpError("Could not list Amazon SP-API report jobs.", error);
    throw new Error("Could not list Amazon SP-API report jobs from Supabase.");
  }

  const rows = ((data ?? []) as AmazonSpReportJobRow[]).map(toSafeReportJob);

  return {
    ok: true,
    sellerId,
    count: rows.length,
    rows
  };
}

async function upsertOrders(sellerId: string, marketplaceId: string, orders: OrderSyncItem[]): Promise<void> {
  if (orders.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase.from("amazon_sp_orders").upsert(
    orders.map((order) => ({
      seller_id: sellerId,
      marketplace_id: marketplaceId,
      amazon_order_id: order.amazonOrderId,
      purchase_date: order.purchaseDate,
      order_status: order.orderStatus,
      fulfillment_channel: order.fulfillmentChannel,
      sales_channel: order.salesChannel,
      order_total_amount: order.orderTotalAmount,
      order_total_currency: order.orderTotalCurrency,
      number_of_items_shipped: order.numberOfItemsShipped,
      number_of_items_unshipped: order.numberOfItemsUnshipped,
      raw_payload: order.rawPayload,
      last_synced_at: now,
      updated_at: now
    })),
    { onConflict: "seller_id,amazon_order_id" }
  );

  if (error) {
    logSafeAmazonSpError("Could not upsert Amazon SP-API orders.", error);
    throw new Error("Could not save Amazon SP-API orders in Supabase.");
  }
}

function safeDbErrorDetails(error: { message?: string; code?: string; details?: string; hint?: string }): SafeDbErrorDetails {
  return {
    code: sanitizeAmazonSpValue(error.code),
    message: sanitizeAmazonSpValue(error.message),
    details: sanitizeAmazonSpValue(error.details),
    hint: sanitizeAmazonSpValue(error.hint)
  };
}

function safeFailedOrderItemRow(rowIndex: number, item: OrderItemSyncItem) {
  const rawPayload = item.rawPayload && typeof item.rawPayload === "object"
    ? item.rawPayload as Record<string, unknown>
    : {};

  return {
    rowIndex,
    amazonOrderIdPresent: Boolean(item.amazonOrderId),
    orderItemIdPresent: Boolean(item.orderItemId),
    sku: item.sku,
    asin: item.asin,
    quantity: item.quantityOrdered,
    itemPrice: item.itemPriceAmount,
    orderStatus: typeof rawPayload.order_status === "string" ? rawPayload.order_status : null
  };
}

function toOrderItemUpsertRow(sellerId: string, item: OrderItemSyncItem, now: string) {
  return {
    seller_id: sellerId,
    amazon_order_id: item.amazonOrderId,
    order_item_id: item.orderItemId,
    asin: item.asin,
    sku: item.sku,
    title: item.title,
    quantity_ordered: item.quantityOrdered,
    quantity_shipped: item.quantityShipped,
    item_price_amount: item.itemPriceAmount,
    item_price_currency: item.itemPriceCurrency,
    item_tax_amount: item.itemTaxAmount,
    promotion_discount_amount: item.promotionDiscountAmount,
    raw_payload: item.rawPayload,
    updated_at: now
  };
}

async function upsertOrderItems(
  sellerId: string,
  items: OrderItemSyncItem[],
  options: { throwOnFailure?: boolean } = {}
): Promise<OrderItemSaveResult> {
  if (items.length === 0) {
    return {
      savedOrderItems: 0,
      failedOrderItems: 0,
      failedRowsSafe: []
    };
  }

  const now = new Date().toISOString();
  const rows = items.map((item) => toOrderItemUpsertRow(sellerId, item, now));
  const { error } = await supabase.from("amazon_sp_order_items").upsert(
    rows,
    { onConflict: "seller_id,order_item_id" }
  );

  if (!error) {
    return {
      savedOrderItems: items.length,
      failedOrderItems: 0,
      failedRowsSafe: []
    };
  }

  logSafeAmazonSpError("Could not batch upsert Amazon SP-API order items. Retrying row-by-row.", error);

  let savedOrderItems = 0;
  const failedRowsSafe: OrderItemSaveResult["failedRowsSafe"] = [];
  let firstError = safeDbErrorDetails(error);

  for (const [index, item] of items.entries()) {
    const { error: rowError } = await supabase
      .from("amazon_sp_order_items")
      .upsert([toOrderItemUpsertRow(sellerId, item, now)], { onConflict: "seller_id,order_item_id" });

    if (rowError) {
      const safeError = safeDbErrorDetails(rowError);
      firstError = firstError.message ? firstError : safeError;
      failedRowsSafe.push(safeFailedOrderItemRow(index + 1, item));
      logSafeAmazonSpError("Could not upsert one Amazon SP-API order item.", rowError);
    } else {
      savedOrderItems += 1;
    }
  }

  const result: OrderItemSaveResult = {
    savedOrderItems,
    failedOrderItems: failedRowsSafe.length,
    dbErrorCode: firstError.code,
    dbErrorMessage: firstError.message,
    dbErrorDetails: firstError.details,
    failedRowsSafe
  };

  if (result.failedOrderItems > 0 && options.throwOnFailure !== false) {
    throw new Error("Could not save Amazon SP-API order items in Supabase.");
  }

  return result;
}

export async function listAmazonSpOrders(sellerIdInput: string, daysInput: number): Promise<SafeAmazonSpOrder[]> {
  const days = Math.min(Math.max(Math.floor(daysInput), 1), 90);
  const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("amazon_sp_orders")
    .select("*")
    .eq("seller_id", sellerIdOrDefault(sellerIdInput))
    .gte("purchase_date", createdAfter)
    .order("purchase_date", { ascending: false })
    .limit(200);

  if (error) {
    logSafeAmazonSpError("Could not list Amazon SP-API orders.", error);
    throw new Error("Could not load Amazon SP-API orders from Supabase.");
  }

  return ((data ?? []) as AmazonSpOrderRow[]).map(toSafeOrder);
}

type OrderSalesStatus = "confirmed" | "pending" | "cancelled" | "unknown";

function classifyOrderSalesStatus(status: string | null): OrderSalesStatus {
  const normalized = status?.toLowerCase() ?? "";

  if (normalized.includes("cancelled") || normalized.includes("canceled")) {
    return "cancelled";
  }

  if (normalized.includes("pending") || normalized.includes("waiting") || normalized.includes("unshipped")) {
    return "pending";
  }

  if (normalized.includes("shipped") || normalized.includes("delivered") || normalized.includes("completed")) {
    return "confirmed";
  }

  return "unknown";
}

export async function getAmazonSpSalesSummary(sellerIdInput: string, daysInput: number) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const days = Math.min(Math.max(Math.floor(daysInput), 1), 90);
  const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: ordersData, error: ordersError } = await supabase
    .from("amazon_sp_orders")
    .select("amazon_order_id, order_total_amount, order_status")
    .eq("seller_id", sellerId)
    .gte("purchase_date", createdAfter);

  if (ordersError) {
    logSafeAmazonSpError("Could not load Amazon SP-API sales summary orders.", ordersError);
    throw new Error("Could not load Amazon SP-API sales summary from Supabase.");
  }

  const statusNote = "Confirmed sales exclude cancelled, pending, and unknown-status orders.";
  const emptyResponse = {
    days,
    rawSales: 0,
    rawOrders: 0,
    rawUnits: 0,
    confirmedSales: 0,
    confirmedOrders: 0,
    confirmedUnits: 0,
    pendingSales: 0,
    pendingOrders: 0,
    pendingUnits: 0,
    cancelledSales: 0,
    cancelledOrders: 0,
    cancelledUnits: 0,
    unknownSales: 0,
    unknownOrders: 0,
    unknownUnits: 0,
    totalSales: 0,
    totalOrders: 0,
    totalUnits: 0,
    averageConfirmedOrderValue: 0,
    averageOrderValue: 0,
    bySku: [],
    statusNote
  };
  const orderRows = (ordersData ?? []) as Array<{
    amazon_order_id: string;
    order_total_amount: number | string | null;
    order_status: string | null;
  }>;
  const orderIds = orderRows.map((order) => order.amazon_order_id);

  if (orderIds.length === 0) {
    return emptyResponse;
  }

  const { data: itemData, error: itemError } = await supabase
    .from("amazon_sp_order_items")
    .select("*")
    .eq("seller_id", sellerId)
    .in("amazon_order_id", orderIds);

  if (itemError) {
    logSafeAmazonSpError("Could not load Amazon SP-API sales summary items.", itemError);
    throw new Error("Could not load Amazon SP-API sales summary from Supabase.");
  }

  const orderStatusById = new Map<string, OrderSalesStatus>();
  const orderTotals = {
    rawSales: 0,
    rawOrders: orderRows.length,
    confirmedSales: 0,
    confirmedOrders: 0,
    pendingSales: 0,
    pendingOrders: 0,
    cancelledSales: 0,
    cancelledOrders: 0,
    unknownSales: 0,
    unknownOrders: 0
  };

  for (const order of orderRows) {
    const status = classifyOrderSalesStatus(order.order_status);
    const amount = toNumberOrNull(order.order_total_amount) ?? 0;
    orderStatusById.set(order.amazon_order_id, status);
    orderTotals.rawSales += amount;

    if (status === "confirmed") {
      orderTotals.confirmedSales += amount;
      orderTotals.confirmedOrders += 1;
    } else if (status === "pending") {
      orderTotals.pendingSales += amount;
      orderTotals.pendingOrders += 1;
    } else if (status === "cancelled") {
      orderTotals.cancelledSales += amount;
      orderTotals.cancelledOrders += 1;
    } else {
      orderTotals.unknownSales += amount;
      orderTotals.unknownOrders += 1;
    }
  }

  const unitTotals = {
    rawUnits: 0,
    confirmedUnits: 0,
    pendingUnits: 0,
    cancelledUnits: 0,
    unknownUnits: 0
  };
  const bySku = new Map<string, {
    sku: string | null;
    asin: string | null;
    title: string | null;
    confirmedUnits: number;
    confirmedSales: number;
    confirmedOrders: Set<string>;
    pendingUnits: number;
    pendingSales: number;
    pendingOrders: Set<string>;
    cancelledUnits: number;
    cancelledSales: number;
    cancelledOrders: Set<string>;
    unknownUnits: number;
    unknownSales: number;
    unknownOrders: Set<string>;
  }>();

  for (const item of (itemData ?? []) as AmazonSpOrderItemRow[]) {
    const key = item.sku ?? item.asin ?? "UNKNOWN";
    const current = bySku.get(key) ?? {
      sku: item.sku,
      asin: item.asin,
      title: item.title,
      confirmedUnits: 0,
      confirmedSales: 0,
      confirmedOrders: new Set<string>(),
      pendingUnits: 0,
      pendingSales: 0,
      pendingOrders: new Set<string>(),
      cancelledUnits: 0,
      cancelledSales: 0,
      cancelledOrders: new Set<string>(),
      unknownUnits: 0,
      unknownSales: 0,
      unknownOrders: new Set<string>()
    };

    const status = orderStatusById.get(item.amazon_order_id) ?? "unknown";
    const units = item.quantity_ordered ?? 0;
    const sales = toNumberOrNull(item.item_price_amount) ?? 0;
    unitTotals.rawUnits += units;

    if (status === "confirmed") {
      unitTotals.confirmedUnits += units;
      current.confirmedUnits += units;
      current.confirmedSales += sales;
      current.confirmedOrders.add(item.amazon_order_id);
    } else if (status === "pending") {
      unitTotals.pendingUnits += units;
      current.pendingUnits += units;
      current.pendingSales += sales;
      current.pendingOrders.add(item.amazon_order_id);
    } else if (status === "cancelled") {
      unitTotals.cancelledUnits += units;
      current.cancelledUnits += units;
      current.cancelledSales += sales;
      current.cancelledOrders.add(item.amazon_order_id);
    } else {
      unitTotals.unknownUnits += units;
      current.unknownUnits += units;
      current.unknownSales += sales;
      current.unknownOrders.add(item.amazon_order_id);
    }

    bySku.set(key, current);
  }

  // Bulk lookup (one call, not one per SKU) so the Sales & Ads "Top Products by Real Sales" card
  // can show a real product photo instead of a generic icon.
  const imageLookup = await getProductImageLookup(sellerId);

  return {
    days,
    rawSales: orderTotals.rawSales,
    rawOrders: orderTotals.rawOrders,
    rawUnits: unitTotals.rawUnits,
    confirmedSales: orderTotals.confirmedSales,
    confirmedOrders: orderTotals.confirmedOrders,
    confirmedUnits: unitTotals.confirmedUnits,
    pendingSales: orderTotals.pendingSales,
    pendingOrders: orderTotals.pendingOrders,
    pendingUnits: unitTotals.pendingUnits,
    cancelledSales: orderTotals.cancelledSales,
    cancelledOrders: orderTotals.cancelledOrders,
    cancelledUnits: unitTotals.cancelledUnits,
    unknownSales: orderTotals.unknownSales,
    unknownOrders: orderTotals.unknownOrders,
    unknownUnits: unitTotals.unknownUnits,
    totalSales: orderTotals.confirmedSales,
    totalOrders: orderTotals.confirmedOrders,
    totalUnits: unitTotals.confirmedUnits,
    averageConfirmedOrderValue: orderTotals.confirmedOrders > 0
      ? orderTotals.confirmedSales / orderTotals.confirmedOrders
      : 0,
    averageOrderValue: orderTotals.confirmedOrders > 0
      ? orderTotals.confirmedSales / orderTotals.confirmedOrders
      : 0,
    bySku: Array.from(bySku.values())
      .map((row) => ({
        sku: row.sku,
        asin: row.asin,
        title: row.title,
        imageUrl: lookupProductImage(imageLookup, row.sku, row.asin),
        units: row.confirmedUnits,
        sales: row.confirmedSales,
        orders: row.confirmedOrders.size,
        confirmedUnits: row.confirmedUnits,
        confirmedSales: row.confirmedSales,
        confirmedOrders: row.confirmedOrders.size,
        pendingUnits: row.pendingUnits,
        pendingSales: row.pendingSales,
        pendingOrders: row.pendingOrders.size,
        cancelledUnits: row.cancelledUnits,
        cancelledSales: row.cancelledSales,
        cancelledOrders: row.cancelledOrders.size,
        unknownUnits: row.unknownUnits,
        unknownSales: row.unknownSales,
        unknownOrders: row.unknownOrders.size
      }))
      .sort((left, right) => right.confirmedSales - left.confirmedSales),
    statusNote
  };
}
