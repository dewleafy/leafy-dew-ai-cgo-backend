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
  smallDelay,
  toIntegerOrNull,
  toNumberOrNull
} from "./amazon-sp-utils";

const LISTINGS_REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const ORDERS_REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
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
    mainImageUrl: row.main_image_url,
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
        const images = Array.isArray(summary.mainImage) ? [] : summary.mainImage && typeof summary.mainImage === "object" ? [summary.mainImage as Record<string, unknown>] : [];
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
          mainImageUrl: cleanText(String(images[0]?.link ?? "")),
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

function parseListingReportText(text: string): { listings: ListingSyncItem[]; skippedCount: number } {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const lines = withoutBom
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { listings: [], skippedCount: 0 };
  }

  const headers = splitTabDelimitedLine(lines[0]).map((header) => header.trim().toLowerCase());
  const listings: ListingSyncItem[] = [];
  let skippedCount = 0;

  for (const line of lines.slice(1)) {
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

  return { listings, skippedCount };
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
    const { listings, skippedCount } = parseListingReportText(reportText);

    await upsertAmazonSpListingRows({ sellerId, connection, listings });
    const passportCount = await upsertProductPassportsFromListings(sellerId, listings);
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
        upsertedProductPassports: passportCount,
        skippedCount
      }
    });

    return {
      ok: true,
      source: "REPORTS_API",
      reportType: LISTINGS_REPORT_TYPE,
      reportId,
      syncedCount: listings.length,
      upsertedProductPassports: passportCount,
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

async function upsertProductPassportsFromListings(sellerId: string, listings: ListingSyncItem[]): Promise<number> {
  let count = 0;

  for (const listing of listings) {
    const existing = await findProductPassportForListing(sellerId, listing);
    const status = listingLooksActive(listing.listingStatus) ? "ACTIVE" : "NEEDS_REVIEW";

    if (existing) {
      const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (!existing.sku && listing.sku) updateRow.sku = listing.sku;
      if (!existing.asin && listing.asin) updateRow.asin = listing.asin;
      if (!existing.product_name && listing.productName) updateRow.product_name = listing.productName;
      if (!existing.product_type && listing.productType) updateRow.product_type = listing.productType;
      if (!existing.category && listing.productType) updateRow.category = listing.productType;
      if (!existing.selling_price && listing.price !== null) updateRow.selling_price = listing.price;
      if (existing.status === "DRAFT") updateRow.status = status;

      if (Object.keys(updateRow).length > 1) {
        const { error } = await supabase.from("product_passports").update(updateRow).eq("id", existing.id);
        if (error) logSafeAmazonSpError("Could not update product passport from Amazon listing.", error);
        else count += 1;
      }
      continue;
    }

    const { error } = await supabase.from("product_passports").insert({
      seller_id: sellerId,
      sku: listing.sku,
      asin: listing.asin,
      product_name: listing.productName ?? listing.sku,
      brand: "Leafy Dew",
      category: listing.productType,
      product_type: listing.productType,
      selling_price: listing.price,
      status
    });

    if (error) {
      logSafeAmazonSpError("Could not create product passport from Amazon listing.", error);
    } else {
      count += 1;
    }
  }

  return count;
}

async function requireConnectedConnection(sellerId: string): Promise<AmazonSpConnectionRow> {
  const connection = await getConnection(sellerId);

  if (connection && (connection.token_status === "CONNECTED" || env.SP_API_REFRESH_TOKEN)) {
    return connection;
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
}): Promise<string> {
  const now = Date.now();
  const response = await amazonSpPost<AmazonSpReportResponse>({
    path: "/reports/2021-06-30/reports",
    accessToken: input.accessToken,
    region: input.region,
    stage: "CREATE_ORDER_REPORT",
    body: {
      reportType: ORDERS_REPORT_TYPE,
      marketplaceIds: [input.marketplaceId],
      dataStartTime: new Date(now - input.days * 24 * 60 * 60 * 1000).toISOString(),
      dataEndTime: new Date(now - 2 * 60 * 1000).toISOString()
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
  reportId?: string;
}): Promise<{ reportId: string; report: AmazonSpReportResponse }> {
  const reportId = input.reportId ?? await createOrderReport({
    accessToken: input.accessToken,
    region: input.region,
    marketplaceId: input.marketplaceId,
    days: input.days
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

  for (const line of lines.slice(1)) {
    const cells = splitTabDelimitedLine(line);
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });

    if (Object.values(row).every((value) => value.length === 0)) {
      continue;
    }

    const amazonOrderId = reportValue(row, ["order-id"]);
    const orderItemId = reportValue(row, ["order-item-id"]);

    if (!amazonOrderId || !orderItemId) {
      skippedCount += 1;
      continue;
    }

    const purchaseDate = reportValue(row, ["purchase-date"]);
    const paymentsDate = reportValue(row, ["payments-date"]);
    const orderStatus = reportValue(row, ["order-status"]);
    const fulfillmentChannel = reportValue(row, ["fulfillment-channel"]);
    const salesChannel = reportValue(row, ["sales-channel"]);
    const quantityOrdered = toIntegerOrNull(reportValue(row, ["quantity-purchased"])) ?? 0;
    const itemPriceAmount = reportNumber(row, ["item-price"]);
    const itemTaxAmount = reportNumber(row, ["item-tax"]);
    const promotionDiscountAmount = reportNumber(row, ["promotion-discount"]);
    const asin = reportValue(row, ["asin"]);
    const sku = reportValue(row, ["sku"]);
    const title = reportValue(row, ["product-name"]);

    const sanitizedItemPayload = {
      amazonOrderId,
      orderItemId,
      purchaseDate,
      paymentsDate,
      sku,
      asin,
      title,
      quantityOrdered,
      itemPriceAmount,
      itemTaxAmount,
      promotionDiscountAmount,
      orderStatus,
      fulfillmentChannel,
      salesChannel
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
      itemPriceCurrency: "INR",
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
      orderTotalCurrency: "INR",
      numberOfItemsShipped: 0,
      numberOfItemsUnshipped: null,
      rawPayload: {
        amazonOrderId,
        purchaseDate,
        paymentsDate,
        orderStatus,
        fulfillmentChannel,
        salesChannel,
        itemCount: 0
      }
    };

    existingOrder.orderTotalAmount = (existingOrder.orderTotalAmount ?? 0) + (itemPriceAmount ?? 0);
    existingOrder.numberOfItemsShipped = (existingOrder.numberOfItemsShipped ?? 0) + quantityOrdered;
    existingOrder.purchaseDate = existingOrder.purchaseDate ?? purchaseDate;
    existingOrder.orderStatus = existingOrder.orderStatus ?? orderStatus;
    existingOrder.fulfillmentChannel = existingOrder.fulfillmentChannel ?? fulfillmentChannel;
    existingOrder.salesChannel = existingOrder.salesChannel ?? salesChannel;
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
    await upsertOrderItems(sellerId, parsed.orderItems);
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
        syncedOrderItems: parsed.orderItems.length,
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
      syncedOrderItems: parsed.orderItems.length,
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

async function upsertOrderItems(sellerId: string, items: OrderItemSyncItem[]): Promise<void> {
  if (items.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase.from("amazon_sp_order_items").upsert(
    items.map((item) => ({
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
    })),
    { onConflict: "seller_id,order_item_id" }
  );

  if (error) {
    logSafeAmazonSpError("Could not upsert Amazon SP-API order items.", error);
    throw new Error("Could not save Amazon SP-API order items in Supabase.");
  }
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

export async function getAmazonSpSalesSummary(sellerIdInput: string, daysInput: number) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const days = Math.min(Math.max(Math.floor(daysInput), 1), 90);
  const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: ordersData, error: ordersError } = await supabase
    .from("amazon_sp_orders")
    .select("amazon_order_id, order_total_amount")
    .eq("seller_id", sellerId)
    .gte("purchase_date", createdAfter);

  if (ordersError) {
    logSafeAmazonSpError("Could not load Amazon SP-API sales summary orders.", ordersError);
    throw new Error("Could not load Amazon SP-API sales summary from Supabase.");
  }

  const orderIds = ((ordersData ?? []) as Array<{ amazon_order_id: string; order_total_amount: number | string | null }>)
    .map((order) => order.amazon_order_id);
  const totalSales = ((ordersData ?? []) as Array<{ order_total_amount: number | string | null }>)
    .reduce((sum, order) => sum + (toNumberOrNull(order.order_total_amount) ?? 0), 0);

  if (orderIds.length === 0) {
    return {
      days,
      totalSales: 0,
      totalOrders: 0,
      totalUnits: 0,
      averageOrderValue: 0,
      bySku: []
    };
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

  const bySku = new Map<string, { sku: string | null; asin: string | null; title: string | null; units: number; sales: number; orders: Set<string> }>();
  for (const item of (itemData ?? []) as AmazonSpOrderItemRow[]) {
    const key = item.sku ?? item.asin ?? "UNKNOWN";
    const current = bySku.get(key) ?? {
      sku: item.sku,
      asin: item.asin,
      title: item.title,
      units: 0,
      sales: 0,
      orders: new Set<string>()
    };
    current.units += item.quantity_ordered ?? 0;
    current.sales += toNumberOrNull(item.item_price_amount) ?? 0;
    current.orders.add(item.amazon_order_id);
    bySku.set(key, current);
  }

  const totalUnits = Array.from(bySku.values()).reduce((sum, row) => sum + row.units, 0);

  return {
    days,
    totalSales,
    totalOrders: orderIds.length,
    totalUnits,
    averageOrderValue: orderIds.length > 0 ? totalSales / orderIds.length : 0,
    bySku: Array.from(bySku.values())
      .map((row) => ({
        sku: row.sku,
        asin: row.asin,
        title: row.title,
        units: row.units,
        sales: row.sales,
        orders: row.orders.size
      }))
      .sort((left, right) => right.sales - left.sales)
  };
}
