export type OrderEconomicsProfitStatus = "PROFIT" | "LOSS" | "BREAKEVEN" | "NEEDS_COST_DATA";

// Per-unit fee breakdown reused directly from the saved Product Economics
// row (the Financial Truth Engine), so the founder can see exactly which
// charge is eating into a specific order's profit — not just one lump
// "non-ad cost" number.
export type OrderEconomicsFeeBreakdown = {
  landedCost: number;
  referralFee: number;
  closingFee: number;
  shippingFee: number;
  pickAndPackFee: number;
  storageFee: number;
  gstOnAmazonFees: number;
  returnReservePerUnit: number;
};

// One order item ("line") inside an Amazon order, with real revenue from
// amazon_sp_order_items, an estimated non-ad cost per unit reused from the
// Financial Truth Engine (product-economics module), and this line's share
// of that day's real per-ASIN ad spend (amazon_ads_advertised_product_daily_metrics),
// allocated proportionally to how many units of that ASIN sold that day.
// This is what answers the founder's "how much did I actually spend on ads
// to get THIS order" question — pooled across all campaigns that touched
// that ASIN that day, not just the one campaign that happens to be credited
// with the sale, because ad spend on a different campaign for the same
// product on the same day is real cost that contributed to that day's sales
// even when Amazon's own attribution credits a different campaign.
export type OrderEconomicsLine = {
  amazonOrderId: string;
  orderItemId: string;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  imageUrl: string | null;
  purchaseDate: string | null;
  quantityOrdered: number;
  itemRevenue: number;
  itemTax: number;
  promotionDiscount: number;
  unitRevenue: number;
  nonAdCostPerUnit: number | null;
  nonAdCostTotal: number | null;
  feeBreakdownPerUnit: OrderEconomicsFeeBreakdown | null;
  feeBreakdownTotal: OrderEconomicsFeeBreakdown | null;
  allocatedAdSpend: number;
  hasAdSpendDataForAsinDate: boolean;
  estimatedProfit: number | null;
  profitStatus: OrderEconomicsProfitStatus;
  missingCostDataReason: string | null;
};

export type OrderEconomicsOrderRow = {
  amazonOrderId: string;
  purchaseDate: string | null;
  orderStatus: string | null;
  fulfillmentChannel: string | null;
  salesChannel: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostalCode: string | null;
  shipToCountry: string | null;
  isCancelled: boolean;
  lines: OrderEconomicsLine[];
  orderRevenue: number;
  orderNonAdCost: number | null;
  orderAdSpend: number;
  orderEstimatedProfit: number | null;
  profitStatus: OrderEconomicsProfitStatus;
};

export type OrderEconomicsProductRollup = {
  sku: string | null;
  asin: string | null;
  productName: string | null;
  orderCount: number;
  unitsSold: number;
  totalRevenue: number;
  totalNonAdCost: number;
  totalAdSpend: number;
  totalEstimatedProfit: number;
};

export type OrderEconomicsSummary = {
  ordersConsidered: number;
  cancelledOrdersExcluded: number;
  totalRevenue: number;
  totalNonAdCost: number;
  totalAdSpend: number;
  totalEstimatedProfit: number;
  profitableOrderCount: number;
  lossOrderCount: number;
  breakevenOrderCount: number;
  needsCostDataOrderCount: number;
  zeroConversionAdSpend: number;
  zeroConversionAsinDateCount: number;
};

export type OrderEconomicsResponse = {
  dateRange: { startDate: string; endDate: string };
  summary: OrderEconomicsSummary;
  orders: OrderEconomicsOrderRow[];
  topLossProducts: OrderEconomicsProductRollup[];
  topProfitProducts: OrderEconomicsProductRollup[];
  productsNeedingCostData: Array<{
    sku: string | null;
    asin: string | null;
    productName: string | null;
    orderCount: number;
  }>;
  caveats: string[];
};
