import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { ProductProfitStatus, SafeProductEconomicsRow } from "../product-economics/product-economics.types";

export type ProductPassportCostStatus = "COMPLETE" | "PARTIAL" | "INCOMPLETE";
export type ProductPassportCostCompletionSource = "listing" | "product" | "economics";

export type ProductPassportCostCompletionRow = {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  title: string | null;
  subcategory: string | null;
  productCost: number | null;
  landedCost: number | null;
  packagingCost: number | null;
  shippingCost: number | null;
  otherCost: number | null;
  requiredProfit: number | null;
  sellingPrice: number | null;
  currentProfitStatus: ProductProfitStatus | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  mainImageUrl: string | null;
  imageUrl: string | null;
  amazonImageUrl: string | null;
  imageSource: string | null;
  lastImageSyncAt: string | null;
  images: string[];
  imageStatus: "AVAILABLE" | "MISSING_FROM_SOURCE";
  missingFields: string[];
  costStatus: ProductPassportCostStatus;
  source: ProductPassportCostCompletionSource;
  updatedAt: string | null;
  existingEconomics: SafeProductEconomicsRow | null;
};

export type ProductPassportCostCompletionBulkItem = {
  sku?: string | null;
  asin?: string | null;
  productCost?: number | null;
  landedCost?: number | null;
  packagingCost?: number | null;
  shippingCost?: number | null;
  otherCost?: number | null;
  requiredProfit?: number | null;
  subcategory?: string | null;
};

export type ProductPassportCostCompletionBulkResult = {
  ok: true;
  sellerId: string;
  requestedCount: number;
  updatedCount: number;
  skippedCount: number;
  rows: ProductPassportCostCompletionRow[];
  resolvedActions?: ProductPassportResolveActionsResult[];
};

export type ProductPassportResolveActionsResult = {
  ok: true;
  sellerId: string;
  sku: string;
  costStatus: ProductPassportCostStatus | null;
  eligible: boolean;
  updatedCount: number;
  skippedCount: number;
  rows: SafeActionLedgerRow[];
  message?: string;
};

export type ProductPassportCostCompletionSummary = {
  ok: true;
  sellerId: string;
  totalSkus: number;
  completeCount: number;
  incompleteCount: number;
  partialCount: number;
  missingCostCount: number;
  missingRequiredProfitCount: number;
  missingSubcategoryCount: number;
  pendingCostActionCount: number;
};
