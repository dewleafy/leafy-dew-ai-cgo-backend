export type ProductProfitStatus = "PASS" | "RISK" | "FAIL" | "UNKNOWN";

export type ProductEconomicsInput = {
  sellerId: string;
  marketplaceId?: string | null;
  asin?: string | null;
  sku?: string | null;
  productName?: string | null;
  sellingPrice: number;
  landedCost: number;
  packagingCost: number;
  amazonFeeEstimate: number;
  shippingFeeEstimate: number;
  taxEstimate: number;
  returnRatePercent: number;
  returnCostPerReturn: number;
  returnReservePerUnit?: number;
  influencerCostAllocationPerUnit: number;
  socialMarketingCostPerUnit: number;
  couponDiscountEstimate: number;
  otherCostPerUnit: number;
  targetProfit?: number;
  notes?: string | null;
};

export type ProductEconomicsCalculation = {
  targetProfit: number;
  targetProfitRule: string;
  returnReservePerUnit: number;
  nonAdCost: number;
  maxAllowableAdSpend: number;
  breakEvenAcos: number;
  targetAcos: number;
  profitStatus: ProductProfitStatus;
};

export type ProductEconomicsExplanation = {
  profitStatus: ProductProfitStatus;
  targetProfit: number;
  nonAdCost: number;
  maxAllowableAdSpend: number;
  breakEvenAcos: number;
  targetAcos: number;
  reason: string;
};

export type ProductEconomicsRow = {
  id: string;
  seller_id: string;
  marketplace_id: string | null;
  asin: string | null;
  sku: string | null;
  product_name: string | null;
  selling_price: number | string;
  landed_cost: number | string | null;
  packaging_cost: number | string | null;
  amazon_fee_estimate: number | string | null;
  shipping_fee_estimate: number | string | null;
  tax_estimate: number | string | null;
  return_rate_percent: number | string | null;
  return_cost_per_return: number | string | null;
  return_reserve_per_unit: number | string | null;
  influencer_cost_allocation_per_unit: number | string | null;
  social_marketing_cost_per_unit: number | string | null;
  coupon_discount_estimate: number | string | null;
  other_cost_per_unit: number | string | null;
  target_profit: number | string;
  target_profit_rule: string | null;
  non_ad_cost: number | string | null;
  max_allowable_ad_spend: number | string | null;
  break_even_acos: number | string | null;
  target_acos: number | string | null;
  profit_status: ProductProfitStatus;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeProductEconomicsRow = {
  id: string;
  sellerId: string;
  marketplaceId: string | null;
  asin: string | null;
  sku: string | null;
  productName: string | null;
  sellingPrice: number;
  landedCost: number;
  packagingCost: number;
  amazonFeeEstimate: number;
  shippingFeeEstimate: number;
  taxEstimate: number;
  returnRatePercent: number;
  returnCostPerReturn: number;
  returnReservePerUnit: number;
  influencerCostAllocationPerUnit: number;
  socialMarketingCostPerUnit: number;
  couponDiscountEstimate: number;
  otherCostPerUnit: number;
  targetProfit: number;
  targetProfitRule: string | null;
  nonAdCost: number;
  maxAllowableAdSpend: number;
  breakEvenAcos: number;
  targetAcos: number;
  profitStatus: ProductProfitStatus;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
