export type CompetitorBenchmarkRunStatus =
  | "DISCOVERING"
  | "AWAITING_CONFIRMATION"
  | "COMPARING"
  | "DONE"
  | "FAILED";

export type CompetitorBenchmarkCandidateSource = "CATALOG_SEARCH" | "MANUAL" | "OWN_BASELINE" | "EXISTING_PASSPORT";

export type CompetitorBenchmarkFetchStatus = "PENDING" | "FETCHED" | "FAILED";

export type CompetitorBenchmarkDimension =
  | "PRICE"
  | "IMAGE_COUNT"
  | "BULLET_COUNT"
  | "TITLE_LENGTH"
  | "CATEGORY_SALES_RANK";

export type CompetitorBenchmarkRunRow = {
  id: string;
  seller_id: string;
  own_skus: string[];
  status: CompetitorBenchmarkRunStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type CompetitorBenchmarkCandidateRow = {
  id: string;
  run_id: string;
  seller_id: string;
  own_sku: string;
  own_asin: string | null;
  asin: string;
  title: string | null;
  source: CompetitorBenchmarkCandidateSource;
  confirmed: boolean | null;
  added_manually: boolean;
  discovery_error: string | null;
  created_at: string;
  updated_at: string;
};

export type CompetitorBenchmarkDataRow = {
  id: string;
  candidate_id: string;
  run_id: string;
  asin: string;
  price: number | string | null;
  currency: string | null;
  rating: number | string | null;
  review_count: number | null;
  image_count: number | null;
  bullet_count: number | null;
  title_length: number | null;
  category_sales_rank: number | null;
  category_sales_rank_title: string | null;
  raw_catalog_payload: Record<string, unknown> | null;
  raw_pricing_payload: Record<string, unknown> | null;
  fetch_status: CompetitorBenchmarkFetchStatus;
  fetch_error: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CompetitorBenchmarkFindingRow = {
  id: string;
  run_id: string;
  own_sku: string;
  dimension: CompetitorBenchmarkDimension;
  own_value: number | string | null;
  best_competitor_value: number | string | null;
  best_competitor_asin: string | null;
  gap_summary: string;
  created_at: string;
};

export type CompetitorBenchmarkImageBriefRow = {
  id: string;
  run_id: string;
  own_sku: string;
  recommended_changes: string[];
  based_on_asins: string[];
  created_at: string;
  updated_at: string;
};

export type CompetitorBenchmarkImageMockupStatus = "NOT_REQUESTED" | "NOT_CONFIGURED" | "QUEUED" | "GENERATED" | "FAILED";

export type CompetitorBenchmarkImageMockupRow = {
  id: string;
  run_id: string;
  own_sku: string;
  image_slot: number;
  status: CompetitorBenchmarkImageMockupStatus;
  mockup_url: string | null;
  note: string | null;
  requested_at: string | null;
  created_at: string;
  updated_at: string;
};

// ---- Founder-facing (camelCase) shapes returned by the API ----

export type SafeCompetitorBenchmarkCandidate = {
  id: string;
  ownSku: string;
  ownAsin: string | null;
  asin: string;
  title: string | null;
  source: CompetitorBenchmarkCandidateSource;
  confirmed: boolean | null;
  addedManually: boolean;
  discoveryError: string | null;
  data: SafeCompetitorBenchmarkData | null;
};

export type SafeCompetitorBenchmarkData = {
  asin: string;
  price: number | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  imageCount: number | null;
  bulletCount: number | null;
  titleLength: number | null;
  categorySalesRank: number | null;
  categorySalesRankTitle: string | null;
  fetchStatus: CompetitorBenchmarkFetchStatus;
  fetchError: string | null;
  fetchedAt: string | null;
};

export type SafeCompetitorBenchmarkFinding = {
  dimension: CompetitorBenchmarkDimension;
  ownValue: number | null;
  bestCompetitorValue: number | null;
  bestCompetitorAsin: string | null;
  gapSummary: string;
};

export type SafeCompetitorBenchmarkImageBrief = {
  ownSku: string;
  recommendedChanges: string[];
  basedOnAsins: string[];
  updatedAt: string;
} | null;

export type SafeCompetitorBenchmarkImageMockup = {
  imageSlot: number;
  status: CompetitorBenchmarkImageMockupStatus;
  mockupUrl: string | null;
  note: string | null;
  requestedAt: string | null;
};

export type SafeCompetitorBenchmarkSkuGroup = {
  ownSku: string;
  ownAsin: string | null;
  candidates: SafeCompetitorBenchmarkCandidate[];
  findings: SafeCompetitorBenchmarkFinding[];
  imageBrief: SafeCompetitorBenchmarkImageBrief;
  imageMockups: SafeCompetitorBenchmarkImageMockup[];
};

export type SafeCompetitorBenchmarkRun = {
  id: string;
  sellerId: string;
  ownSkus: string[];
  status: CompetitorBenchmarkRunStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  skus: SafeCompetitorBenchmarkSkuGroup[];
};
