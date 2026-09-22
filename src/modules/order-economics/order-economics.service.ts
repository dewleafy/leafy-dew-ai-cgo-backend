import { supabase } from "../../db/supabase";
import { cleanText, logSafeAmazonSpError, toNumberOrNull } from "../amazon-sp/amazon-sp-utils";
import { AmazonSpOrderItemRow, AmazonSpOrderRow } from "../amazon-sp/amazon-sp.types";
import { listAmazonSpListings } from "../amazon-sp/amazon-sp.service";
import { listProductEconomics } from "../product-economics/product-economics.service";
import { SafeProductEconomicsRow } from "../product-economics/product-economics.types";
import { listAdvertisedProductMetricsForDateRange } from "../amazon-ads/amazon-ads-report.service";
import {
  OrderEconomicsFeeBreakdown,
  OrderEconomicsLine,
  OrderEconomicsOrderRow,
  OrderEconomicsProductRollup,
  OrderEconomicsProfitStatus,
  OrderEconomicsResponse,
  OrderEconomicsSummary
} from "./order-economics.types";

// A small tolerance band so tiny rounding noise (a few paise) doesn't get
// labelled PROFIT or LOSS. Anything within +/- this amount is BREAKEVEN.
const BREAKEVEN_TOLERANCE_RUPEES = 1;

const CAVEATS: string[] = [
  "Ad spend is pooled per ASIN per day across every campaign that advertised it, then split across that day's real orders for the same product (by quantity) — this is not Amazon's own last-click campaign attribution.",
  "Costs use each product's saved fee estimate from Product Economics (referral fee, closing fee, shipping, pick & pack, storage, GST), not Amazon's real Settlement/Finance report. Treat every number here as an estimate, not a settled figure.",
  "Returns and refunds are not yet tracked (no Amazon Returns or Settlement feed connected yet), so an order shown as profit here can still turn into a loss later if it is returned.",
  "Cancelled orders are excluded from every total on this page.",
  "A product with no saved cost data in Product Economics shows as \"Needs cost data\" instead of a guessed profit number.",
  "Customer details are limited to the ship-to city/state/postal code Amazon's general order report provides. Buyer name and street address are Amazon-restricted PII that this app does not currently have separate approved access to."
];

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeKey(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function isCancelledStatus(status: string | null): boolean {
  const normalized = status?.toLowerCase() ?? "";
  return normalized.includes("cancelled") || normalized.includes("canceled");
}

function toDateKey(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

function classifyProfitStatus(estimatedProfit: number | null): OrderEconomicsProfitStatus {
  if (estimatedProfit === null) return "NEEDS_COST_DATA";
  if (estimatedProfit > BREAKEVEN_TOLERANCE_RUPEES) return "PROFIT";
  if (estimatedProfit < -BREAKEVEN_TOLERANCE_RUPEES) return "LOSS";
  return "BREAKEVEN";
}

async function loadOrdersAndItems(sellerId: string, startDate: string, endDate: string): Promise<{
  orders: AmazonSpOrderRow[];
  itemsByOrderId: Map<string, AmazonSpOrderItemRow[]>;
}> {
  const rangeStart = `${startDate}T00:00:00.000Z`;
  const rangeEnd = `${endDate}T23:59:59.999Z`;

  const { data: orderData, error: orderError } = await supabase
    .from("amazon_sp_orders")
    .select("*")
    .eq("seller_id", sellerId)
    .gte("purchase_date", rangeStart)
    .lte("purchase_date", rangeEnd)
    .order("purchase_date", { ascending: false })
    .limit(1000);

  if (orderError) {
    logSafeAmazonSpError("Could not load Amazon SP-API orders for order economics.", orderError);
    throw new Error("Could not load Amazon SP-API orders for order economics.");
  }

  const orders = (orderData ?? []) as AmazonSpOrderRow[];
  const orderIds = orders.map((order) => order.amazon_order_id);

  if (orderIds.length === 0) {
    return { orders: [], itemsByOrderId: new Map() };
  }

  const { data: itemData, error: itemError } = await supabase
    .from("amazon_sp_order_items")
    .select("*")
    .eq("seller_id", sellerId)
    .in("amazon_order_id", orderIds);

  if (itemError) {
    logSafeAmazonSpError("Could not load Amazon SP-API order items for order economics.", itemError);
    throw new Error("Could not load Amazon SP-API order items for order economics.");
  }

  const itemsByOrderId = new Map<string, AmazonSpOrderItemRow[]>();
  for (const item of (itemData ?? []) as AmazonSpOrderItemRow[]) {
    const list = itemsByOrderId.get(item.amazon_order_id) ?? [];
    list.push(item);
    itemsByOrderId.set(item.amazon_order_id, list);
  }

  return { orders, itemsByOrderId };
}

function extractShipToInfo(rawPayload: Record<string, unknown> | null): {
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostalCode: string | null;
  shipToCountry: string | null;
} {
  const payload = rawPayload ?? {};
  return {
    shipToCity: cleanText(typeof payload.shipCity === "string" ? payload.shipCity : null),
    shipToState: cleanText(typeof payload.shipState === "string" ? payload.shipState : null),
    shipToPostalCode: cleanText(typeof payload.shipPostalCode === "string" ? payload.shipPostalCode : null),
    shipToCountry: cleanText(typeof payload.shipCountry === "string" ? payload.shipCountry : null)
  };
}

function buildFeeBreakdown(economics: SafeProductEconomicsRow, multiplier: number): OrderEconomicsFeeBreakdown {
  const round = (value: number) => Math.round(value * multiplier * 100) / 100;
  return {
    landedCost: round(economics.landedCost),
    referralFee: round(economics.referralFee),
    closingFee: round(economics.closingFee),
    shippingFee: round(economics.shippingFee),
    pickAndPackFee: round(economics.pickAndPackFee),
    storageFee: round(economics.storageFee),
    gstOnAmazonFees: round(economics.gstOnAmazonFees),
    returnReservePerUnit: round(economics.returnReservePerUnit)
  };
}

function buildImageMaps(listings: Array<{ sku: string; asin: string | null; mainImageUrl: string | null; imageUrl: string | null }>): {
  bySku: Map<string, string>;
  byAsin: Map<string, string>;
} {
  const bySku = new Map<string, string>();
  const byAsin = new Map<string, string>();

  for (const listing of listings) {
    const image = listing.mainImageUrl ?? listing.imageUrl ?? null;
    if (!image) continue;
    const skuKey = normalizeKey(listing.sku);
    const asinKey = normalizeKey(listing.asin);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, image);
    if (asinKey && !byAsin.has(asinKey)) byAsin.set(asinKey, image);
  }

  return { bySku, byAsin };
}

function buildEconomicsMaps(rows: SafeProductEconomicsRow[]): {
  bySku: Map<string, SafeProductEconomicsRow>;
  byAsin: Map<string, SafeProductEconomicsRow>;
} {
  const bySku = new Map<string, SafeProductEconomicsRow>();
  const byAsin = new Map<string, SafeProductEconomicsRow>();

  for (const row of rows) {
    const skuKey = normalizeKey(row.sku);
    const asinKey = normalizeKey(row.asin);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, row);
    if (asinKey && !byAsin.has(asinKey)) byAsin.set(asinKey, row);
  }

  return { bySku, byAsin };
}

export async function getOrderEconomics(input: {
  sellerId: string;
  startDate: string;
  endDate: string;
}): Promise<OrderEconomicsResponse> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const { startDate, endDate } = input;

  const [{ orders, itemsByOrderId }, economicsRows, adMetrics, listings] = await Promise.all([
    loadOrdersAndItems(sellerId, startDate, endDate),
    listProductEconomics(sellerId),
    listAdvertisedProductMetricsForDateRange({ sellerId, startDate, endDate }),
    listAmazonSpListings(sellerId, 500).catch(() => [])
  ]);

  const emptySummary: OrderEconomicsSummary = {
    ordersConsidered: 0,
    cancelledOrdersExcluded: 0,
    totalRevenue: 0,
    totalNonAdCost: 0,
    totalAdSpend: 0,
    totalEstimatedProfit: 0,
    profitableOrderCount: 0,
    lossOrderCount: 0,
    breakevenOrderCount: 0,
    needsCostDataOrderCount: 0,
    zeroConversionAdSpend: 0,
    zeroConversionAsinDateCount: 0
  };

  if (orders.length === 0) {
    return {
      dateRange: { startDate, endDate },
      summary: emptySummary,
      orders: [],
      topLossProducts: [],
      topProfitProducts: [],
      productsNeedingCostData: [],
      caveats: CAVEATS
    };
  }

  const { bySku: economicsBySku, byAsin: economicsByAsin } = buildEconomicsMaps(economicsRows);
  const { bySku: imageBySku, byAsin: imageByAsin } = buildImageMaps(listings);

  // Sum real ad cost per ASIN per day, pooled across every campaign/ad group
  // that advertised it that day.
  const adCostByAsinDate = new Map<string, number>();
  for (const metric of adMetrics) {
    const asinKey = normalizeKey(metric.advertisedAsin);
    if (!asinKey) continue;
    const key = `${asinKey}|${metric.reportDate}`;
    adCostByAsinDate.set(key, roundTwo((adCostByAsinDate.get(key) ?? 0) + metric.cost));
  }

  // Sum real units sold per ASIN per day (non-cancelled orders only), used
  // as the allocation denominator for that day's pooled ad spend.
  const qtyByAsinDate = new Map<string, number>();
  for (const order of orders) {
    if (isCancelledStatus(order.order_status)) continue;
    const dateKey = toDateKey(order.purchase_date);
    if (!dateKey) continue;
    const items = itemsByOrderId.get(order.amazon_order_id) ?? [];
    for (const item of items) {
      const asinKey = normalizeKey(item.asin);
      if (!asinKey) continue;
      const qty = toNumberOrNull(item.quantity_ordered) ?? 1;
      const key = `${asinKey}|${dateKey}`;
      qtyByAsinDate.set(key, (qtyByAsinDate.get(key) ?? 0) + Math.max(qty, 1));
    }
  }

  const orderRows: OrderEconomicsOrderRow[] = [];
  let cancelledOrdersExcluded = 0;

  for (const order of orders) {
    if (isCancelledStatus(order.order_status)) {
      cancelledOrdersExcluded += 1;
      continue;
    }

    const dateKey = toDateKey(order.purchase_date);
    const items = itemsByOrderId.get(order.amazon_order_id) ?? [];
    const lines: OrderEconomicsLine[] = items.map((item) => {
      const asin = cleanText(item.asin);
      const sku = cleanText(item.sku);
      const asinKey = normalizeKey(asin);
      const skuKey = normalizeKey(sku);
      const quantityOrdered = Math.max(toNumberOrNull(item.quantity_ordered) ?? 1, 1);
      const itemRevenueRaw = toNumberOrNull(item.item_price_amount) ?? 0;
      const promotionDiscount = toNumberOrNull(item.promotion_discount_amount) ?? 0;
      const itemTax = toNumberOrNull(item.item_tax_amount) ?? 0;
      const itemRevenue = roundTwo(itemRevenueRaw - promotionDiscount);
      const unitRevenue = roundTwo(itemRevenue / quantityOrdered);

      const economics = (skuKey ? economicsBySku.get(skuKey) : undefined) ?? (asinKey ? economicsByAsin.get(asinKey) : undefined) ?? null;
      const hasUsableCostData = Boolean(economics) && economics!.profitDataStatus === "AVAILABLE";
      const nonAdCostPerUnit = hasUsableCostData ? economics!.nonAdCost : null;
      const nonAdCostTotal = nonAdCostPerUnit !== null ? roundTwo(nonAdCostPerUnit * quantityOrdered) : null;
      const feeBreakdownPerUnit = hasUsableCostData ? buildFeeBreakdown(economics!, 1) : null;
      const feeBreakdownTotal = hasUsableCostData ? buildFeeBreakdown(economics!, quantityOrdered) : null;
      const imageUrl = (skuKey ? imageBySku.get(skuKey) : undefined) ?? (asinKey ? imageByAsin.get(asinKey) : undefined) ?? null;

      const asinDateKey = asinKey && dateKey ? `${asinKey}|${dateKey}` : null;
      const dayAdCost = asinDateKey ? adCostByAsinDate.get(asinDateKey) ?? 0 : 0;
      const dayQty = asinDateKey ? qtyByAsinDate.get(asinDateKey) ?? 0 : 0;
      const allocatedAdSpend = dayAdCost > 0 && dayQty > 0 ? roundTwo(dayAdCost * (quantityOrdered / dayQty)) : 0;

      const estimatedProfit = nonAdCostTotal !== null ? roundTwo(itemRevenue - nonAdCostTotal - allocatedAdSpend) : null;

      const missingCostDataReason = hasUsableCostData
        ? null
        : economics
          ? economics.reason
          : "No saved cost data for this SKU yet in Product Economics.";

      return {
        amazonOrderId: order.amazon_order_id,
        orderItemId: item.order_item_id,
        sku,
        asin,
        productName: cleanText(item.title) ?? economics?.productName ?? null,
        imageUrl,
        purchaseDate: order.purchase_date,
        quantityOrdered,
        itemRevenue,
        itemTax,
        promotionDiscount,
        unitRevenue,
        nonAdCostPerUnit,
        nonAdCostTotal,
        feeBreakdownPerUnit,
        feeBreakdownTotal,
        allocatedAdSpend,
        hasAdSpendDataForAsinDate: dayAdCost > 0,
        estimatedProfit,
        profitStatus: classifyProfitStatus(estimatedProfit),
        missingCostDataReason
      };
    });

    const orderRevenue = roundTwo(lines.reduce((sum, line) => sum + line.itemRevenue, 0));
    const orderAdSpend = roundTwo(lines.reduce((sum, line) => sum + line.allocatedAdSpend, 0));
    const hasAllCostData = lines.length > 0 && lines.every((line) => line.nonAdCostTotal !== null);
    const orderNonAdCost = hasAllCostData ? roundTwo(lines.reduce((sum, line) => sum + (line.nonAdCostTotal ?? 0), 0)) : null;
    const orderEstimatedProfit = hasAllCostData ? roundTwo(orderRevenue - (orderNonAdCost ?? 0) - orderAdSpend) : null;
    const shipToInfo = extractShipToInfo(order.raw_payload);

    orderRows.push({
      amazonOrderId: order.amazon_order_id,
      purchaseDate: order.purchase_date,
      orderStatus: order.order_status,
      fulfillmentChannel: order.fulfillment_channel,
      salesChannel: order.sales_channel,
      ...shipToInfo,
      isCancelled: false,
      lines,
      orderRevenue,
      orderNonAdCost,
      orderAdSpend,
      orderEstimatedProfit,
      profitStatus: classifyProfitStatus(orderEstimatedProfit)
    });
  }

  // Ad spend that landed on an ASIN/day with zero real orders for that
  // product that day — this is spend the founder is directly asking to see
  // ("I spend on the whole day but don't get sales, and can't find why").
  let zeroConversionAdSpend = 0;
  let zeroConversionAsinDateCount = 0;
  for (const [key, cost] of adCostByAsinDate.entries()) {
    const qty = qtyByAsinDate.get(key) ?? 0;
    if (qty === 0 && cost > 0) {
      zeroConversionAdSpend = roundTwo(zeroConversionAdSpend + cost);
      zeroConversionAsinDateCount += 1;
    }
  }

  const summary: OrderEconomicsSummary = {
    ordersConsidered: orderRows.length,
    cancelledOrdersExcluded,
    totalRevenue: roundTwo(orderRows.reduce((sum, order) => sum + order.orderRevenue, 0)),
    totalNonAdCost: roundTwo(orderRows.reduce((sum, order) => sum + (order.orderNonAdCost ?? 0), 0)),
    totalAdSpend: roundTwo(orderRows.reduce((sum, order) => sum + order.orderAdSpend, 0)),
    totalEstimatedProfit: roundTwo(orderRows.reduce((sum, order) => sum + (order.orderEstimatedProfit ?? 0), 0)),
    profitableOrderCount: orderRows.filter((order) => order.profitStatus === "PROFIT").length,
    lossOrderCount: orderRows.filter((order) => order.profitStatus === "LOSS").length,
    breakevenOrderCount: orderRows.filter((order) => order.profitStatus === "BREAKEVEN").length,
    needsCostDataOrderCount: orderRows.filter((order) => order.profitStatus === "NEEDS_COST_DATA").length,
    zeroConversionAdSpend,
    zeroConversionAsinDateCount
  };

  // Product-level rollups, built from every line across every order.
  const rollupByKey = new Map<string, OrderEconomicsProductRollup>();
  const needsCostDataByKey = new Map<string, { sku: string | null; asin: string | null; productName: string | null; orderIds: Set<string> }>();

  for (const order of orderRows) {
    for (const line of order.lines) {
      const key = normalizeKey(line.sku) ?? normalizeKey(line.asin) ?? "unknown";

      if (line.profitStatus === "NEEDS_COST_DATA") {
        const entry = needsCostDataByKey.get(key) ?? {
          sku: line.sku,
          asin: line.asin,
          productName: line.productName,
          orderIds: new Set<string>()
        };
        entry.orderIds.add(order.amazonOrderId);
        needsCostDataByKey.set(key, entry);
        continue;
      }

      const rollup = rollupByKey.get(key) ?? {
        sku: line.sku,
        asin: line.asin,
        productName: line.productName,
        orderCount: 0,
        unitsSold: 0,
        totalRevenue: 0,
        totalNonAdCost: 0,
        totalAdSpend: 0,
        totalEstimatedProfit: 0
      };

      rollup.orderCount += 1;
      rollup.unitsSold += line.quantityOrdered;
      rollup.totalRevenue = roundTwo(rollup.totalRevenue + line.itemRevenue);
      rollup.totalNonAdCost = roundTwo(rollup.totalNonAdCost + (line.nonAdCostTotal ?? 0));
      rollup.totalAdSpend = roundTwo(rollup.totalAdSpend + line.allocatedAdSpend);
      rollup.totalEstimatedProfit = roundTwo(rollup.totalEstimatedProfit + (line.estimatedProfit ?? 0));
      rollupByKey.set(key, rollup);
    }
  }

  const rollups = Array.from(rollupByKey.values());
  const topLossProducts = [...rollups]
    .filter((row) => row.totalEstimatedProfit < -BREAKEVEN_TOLERANCE_RUPEES)
    .sort((a, b) => a.totalEstimatedProfit - b.totalEstimatedProfit)
    .slice(0, 10);
  const topProfitProducts = [...rollups]
    .filter((row) => row.totalEstimatedProfit > BREAKEVEN_TOLERANCE_RUPEES)
    .sort((a, b) => b.totalEstimatedProfit - a.totalEstimatedProfit)
    .slice(0, 10);

  const productsNeedingCostData = Array.from(needsCostDataByKey.values())
    .map((entry) => ({
      sku: entry.sku,
      asin: entry.asin,
      productName: entry.productName,
      orderCount: entry.orderIds.size
    }))
    .sort((a, b) => b.orderCount - a.orderCount);

  return {
    dateRange: { startDate, endDate },
    summary,
    orders: orderRows,
    topLossProducts,
    topProfitProducts,
    productsNeedingCostData,
    caveats: CAVEATS
  };
}
