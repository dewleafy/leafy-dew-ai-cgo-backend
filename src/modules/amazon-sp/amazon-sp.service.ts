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
import { amazonSpGet } from "./amazon-sp-client.service";
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
  safeErrorMessage,
  toIntegerOrNull,
  toNumberOrNull
} from "./amazon-sp-utils";

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

export async function syncAmazonSpListings(sellerIdInput: string) {
  const sellerId = sellerIdOrDefault(sellerIdInput);
  const connection = await requireConnectedConnection(sellerId);
  const warnings: string[] = [];

  if (!connection.amazon_seller_id) {
    throw new Error("Amazon seller id is missing. Reconnect Seller Central so SP-API can identify the seller account.");
  }

  await logSpActivity({ sellerId, action: "SYNC_LISTINGS_STARTED", status: "INFO", message: "Amazon SP-API listing sync started." });

  try {
    const accessToken = await getAmazonSpAccessToken(connection.id);
    const listings: ListingSyncItem[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const response = await amazonSpGet<unknown>({
        path: `/listings/2021-08-01/items/${encodeURIComponent(connection.amazon_seller_id)}`,
        accessToken,
        region: connection.region,
        query: {
          marketplaceIds: connection.marketplace_id,
          includedData: "summaries,offers,fulfillmentAvailability",
          pageSize: 20,
          pageToken
        }
      });
      const parsed = extractListings(response);
      listings.push(...parsed.items);
      if (!parsed.nextToken) break;
      pageToken = parsed.nextToken;
    }

    const now = new Date().toISOString();
    const upsertRows = listings.map((listing) => ({
      seller_id: sellerId,
      amazon_seller_id: connection.amazon_seller_id,
      marketplace_id: connection.marketplace_id,
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
    }));

    if (upsertRows.length > 0) {
      const { error } = await supabase
        .from("amazon_sp_listings")
        .upsert(upsertRows, { onConflict: "seller_id,marketplace_id,sku" });

      if (error) {
        logSafeAmazonSpError("Could not upsert Amazon SP-API listings.", error);
        throw new Error("Could not save Amazon SP-API listings in Supabase.");
      }
    }

    const passportCount = await upsertProductPassportsFromListings(sellerId, listings);
    await updateConnectionError(connection.id, null);
    await logSpActivity({
      sellerId,
      action: "SYNC_LISTINGS_COMPLETED",
      status: "SUCCESS",
      message: "Amazon SP-API listing sync completed.",
      metadata: { syncedCount: listings.length, upsertedProductPassports: passportCount }
    });

    return {
      syncedCount: listings.length,
      upsertedProductPassports: passportCount,
      skippedCount: 0,
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

async function upsertProductPassportsFromListings(sellerId: string, listings: ListingSyncItem[]): Promise<number> {
  let count = 0;

  for (const listing of listings) {
    const { data: existingRows, error: loadError } = await supabase
      .from("product_passports")
      .select("*")
      .eq("seller_id", sellerId)
      .eq("sku", listing.sku)
      .limit(1);

    if (loadError) {
      logSafeAmazonSpError("Could not load product passport during listing import.", loadError);
      continue;
    }

    const existing = Array.isArray(existingRows) ? existingRows[0] as Record<string, unknown> | undefined : undefined;
    const status = listing.listingStatus?.toUpperCase().includes("ACTIVE") ? "ACTIVE" : "NEEDS_REVIEW";

    if (existing) {
      const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (!existing.asin && listing.asin) updateRow.asin = listing.asin;
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
