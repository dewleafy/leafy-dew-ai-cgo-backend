export type AplusContentStatus = "FOUND" | "NOT_FOUND" | "APPROVED" | "SUBMITTED" | "REJECTED" | "DRAFT";

export type NormalizedAplusBlock = {
  headline?: string;
  body?: string;
  image?: string;
};

export type NormalizedAplusModule = {
  type: string;
  headline?: string;
  body?: string;
  images: string[];
  items: NormalizedAplusBlock[];
  debugKeys?: string[];
};

export type AplusContentCacheRow = {
  id: string;
  seller_id: string;
  asin: string;
  content_reference_key: string | null;
  status: AplusContentStatus;
  content_module_list: NormalizedAplusModule[];
  fetched_at: string;
  created_at: string;
  updated_at: string;
};

export type AplusContentReport = {
  ok: true;
  asin: string;
  status: AplusContentStatus;
  moduleCount: number;
  modules: NormalizedAplusModule[];
  fetchedAt: string;
  source: "CACHED" | "FETCHED_LIVE";
  warning?: string;
};

// Account-wide A+ Content coverage — separate from the single-ASIN preview above. This
// answers "which products have no A+ Content at all", the same shape of question Brand
// Readiness already answers for brand_positioning/customer_objections, but for A+ Content.
export type AplusCoverageProductStatus = "HAS_CONTENT" | "NO_CONTENT" | "NOT_CHECKED_YET" | "NO_ASIN";

export type AplusCoverageProduct = {
  sku: string | null;
  asin: string | null;
  productName: string;
  brand: string;
  status: AplusCoverageProductStatus;
  moduleCount: number;
  lastCheckedAt: string | null;
};

export type AplusCoverageBrandSummary = {
  brandName: string;
  productCount: number;
  hasContentCount: number;
  noContentCount: number;
  notCheckedCount: number;
};

export type AplusCoverageReport = {
  ok: true;
  brands: AplusCoverageBrandSummary[];
  // Only products confirmed NO_CONTENT (a real check ran and found nothing) — for
  // surfacing "these need A+ Content" in the UI. NOT_CHECKED_YET products are counted in
  // the brand summary but not listed here, since we don't yet know their real status.
  missingProducts: AplusCoverageProduct[];
  uncheckedCount: number;
};

// One batch of the coverage scan (mirrors the listing-drafts generate pattern: capped
// per run, safe to re-run repeatedly until remainingUncheckedCount reaches 0).
export type AplusCoverageScanResult = {
  ok: true;
  scannedCount: number;
  hasContentCount: number;
  noContentCount: number;
  remainingUncheckedCount: number;
};
