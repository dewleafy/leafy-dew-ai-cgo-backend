import { ProductProfitStatus } from "../product-economics/product-economics.types";

export type ListingReadinessStatus = "READY" | "NEEDS_FIX" | "POOR";
export type ListingReadinessPriority = "LOW" | "MEDIUM" | "HIGH";

export type ListingReadinessSection = {
  score: number;
  status: ListingReadinessStatus;
  missingItems: string[];
  warnings: string[];
};

export type ListingReadinessRow = {
  productPassportId: string;
  sku: string | null;
  asin: string | null;
  productName: string;
  category: string | null;
  status: string;
  overallScore: number;
  readinessStatus: ListingReadinessStatus;
  profitStatus: ProductProfitStatus;
  topMissingItems: string[];
  nextBestAction: string;
};
