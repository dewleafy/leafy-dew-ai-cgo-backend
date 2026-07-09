export type DataFreshnessStatusValue = "FRESH" | "STALE" | "UNKNOWN" | "ERROR";

export type DataFreshnessSource =
  | "AMAZON_SP_API_LISTINGS"
  | "AMAZON_SP_API_ORDERS"
  | "AMAZON_ADS"
  | "PRODUCT_PASSPORT"
  | "PRODUCT_ECONOMICS"
  | "ACTION_LEDGER"
  | "ENGINE_ROUTER"
  | "DAILY_ORCHESTRATOR"
  | "LEARNING_LOOP"
  | "EXECUTION_GATEWAY"
  | "LISTING_DRAFTS"
  | "CREATIVE_RECOMMENDATIONS";

export type DataFreshnessStatusRow = {
  id: string;
  seller_id: string;
  data_source: DataFreshnessSource;
  last_success_at: string | null;
  last_attempt_at: string | null;
  status: DataFreshnessStatusValue;
  freshness_minutes: number | null;
  stale_after_minutes: number;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type SafeDataFreshnessStatus = {
  id: string;
  sellerId: string;
  dataSource: DataFreshnessSource;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  status: DataFreshnessStatusValue;
  freshnessMinutes: number | null;
  staleAfterMinutes: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type DataFreshnessMarkInput = {
  sellerId?: string;
  dataSource: DataFreshnessSource;
  status: DataFreshnessStatusValue;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  staleAfterMinutes?: number;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
};
