import { supabase } from "../../db/supabase";
import {
  DataFreshnessMarkInput,
  DataFreshnessSource,
  DataFreshnessStatusRow,
  DataFreshnessStatusValue,
  SafeDataFreshnessStatus
} from "./data-freshness.types";

type SourceConfig = {
  dataSource: DataFreshnessSource;
  table: string;
  timestampColumn: string;
  staleAfterMinutes: number;
  critical: boolean;
};

export const DATA_FRESHNESS_SOURCES: DataFreshnessSource[] = [
  "AMAZON_SP_API_LISTINGS",
  "AMAZON_SP_API_ORDERS",
  "AMAZON_ADS",
  "PRODUCT_PASSPORT",
  "PRODUCT_ECONOMICS",
  "ACTION_LEDGER",
  "ENGINE_ROUTER",
  "DAILY_ORCHESTRATOR",
  "LEARNING_LOOP",
  "EXECUTION_GATEWAY",
  "LISTING_DRAFTS",
  "CREATIVE_RECOMMENDATIONS"
];

const SOURCE_CONFIGS: SourceConfig[] = [
  { dataSource: "AMAZON_SP_API_LISTINGS", table: "amazon_sp_listings", timestampColumn: "last_synced_at", staleAfterMinutes: 1440, critical: true },
  { dataSource: "AMAZON_SP_API_ORDERS", table: "amazon_sp_orders", timestampColumn: "last_synced_at", staleAfterMinutes: 1440, critical: true },
  { dataSource: "AMAZON_ADS", table: "amazon_ads_campaigns", timestampColumn: "last_synced_at", staleAfterMinutes: 1440, critical: true },
  { dataSource: "PRODUCT_PASSPORT", table: "product_passports", timestampColumn: "updated_at", staleAfterMinutes: 10080, critical: true },
  { dataSource: "PRODUCT_ECONOMICS", table: "amazon_product_economics", timestampColumn: "updated_at", staleAfterMinutes: 1440, critical: true },
  { dataSource: "ACTION_LEDGER", table: "action_ledger", timestampColumn: "updated_at", staleAfterMinutes: 1440, critical: true },
  { dataSource: "ENGINE_ROUTER", table: "engine_run_logs", timestampColumn: "started_at", staleAfterMinutes: 1440, critical: false },
  { dataSource: "DAILY_ORCHESTRATOR", table: "daily_orchestrator_runs", timestampColumn: "started_at", staleAfterMinutes: 1440, critical: false },
  { dataSource: "LEARNING_LOOP", table: "action_learning_events", timestampColumn: "created_at", staleAfterMinutes: 10080, critical: false },
  { dataSource: "EXECUTION_GATEWAY", table: "execution_attempts", timestampColumn: "created_at", staleAfterMinutes: 10080, critical: false },
  { dataSource: "LISTING_DRAFTS", table: "listing_optimization_drafts", timestampColumn: "updated_at", staleAfterMinutes: 10080, critical: false },
  { dataSource: "CREATIVE_RECOMMENDATIONS", table: "creative_recommendations", timestampColumn: "updated_at", staleAfterMinutes: 10080, critical: false }
];

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function freshnessMinutes(lastSuccessAt: string | null): number | null {
  if (!lastSuccessAt) return null;
  const millis = Date.parse(lastSuccessAt);
  if (!Number.isFinite(millis)) return null;
  return Math.max(Math.floor((Date.now() - millis) / 60000), 0);
}

function statusFromFreshness(minutes: number | null, staleAfterMinutes: number): DataFreshnessStatusValue {
  if (minutes === null) return "UNKNOWN";
  return minutes > staleAfterMinutes ? "STALE" : "FRESH";
}

function toSafeStatus(row: DataFreshnessStatusRow): SafeDataFreshnessStatus {
  return {
    id: row.id,
    sellerId: row.seller_id,
    dataSource: row.data_source,
    lastSuccessAt: row.last_success_at,
    lastAttemptAt: row.last_attempt_at,
    status: row.status,
    freshnessMinutes: row.freshness_minutes,
    staleAfterMinutes: row.stale_after_minutes,
    lastError: row.last_error,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function deriveSourceStatus(sellerId: string, config: SourceConfig): Promise<DataFreshnessMarkInput> {
  const { data, error } = await supabase
    .from(config.table)
    .select(config.timestampColumn)
    .eq("seller_id", sellerId)
    .order(config.timestampColumn, { ascending: false })
    .limit(1);

  if (error) {
    return {
      sellerId,
      dataSource: config.dataSource,
      status: "UNKNOWN",
      staleAfterMinutes: config.staleAfterMinutes,
      lastError: error.message,
      metadata: { table: config.table, timestampColumn: config.timestampColumn, critical: config.critical, derivation: "table_unavailable" }
    };
  }

  const row = ((data ?? []) as unknown as Array<Record<string, unknown>>)[0];
  const lastSuccessAt = cleanText(row?.[config.timestampColumn]);
  const minutes = freshnessMinutes(lastSuccessAt);
  return {
    sellerId,
    dataSource: config.dataSource,
    status: statusFromFreshness(minutes, config.staleAfterMinutes),
    lastSuccessAt,
    lastAttemptAt: new Date().toISOString(),
    staleAfterMinutes: config.staleAfterMinutes,
    metadata: { table: config.table, timestampColumn: config.timestampColumn, critical: config.critical, derived: true }
  };
}

export async function markDataFreshness(input: DataFreshnessMarkInput): Promise<SafeDataFreshnessStatus> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const lastSuccessAt = cleanText(input.lastSuccessAt);
  const minutes = freshnessMinutes(lastSuccessAt);
  const staleAfterMinutes = input.staleAfterMinutes ? Math.max(Math.floor(input.staleAfterMinutes), 1) : 1440;
  const { data, error } = await supabase
    .from("data_freshness_status")
    .upsert({
      seller_id: sellerId,
      data_source: input.dataSource,
      last_success_at: lastSuccessAt,
      last_attempt_at: cleanText(input.lastAttemptAt) ?? new Date().toISOString(),
      status: input.status,
      freshness_minutes: minutes,
      stale_after_minutes: staleAfterMinutes,
      last_error: cleanText(input.lastError),
      metadata: input.metadata ?? {},
      updated_at: new Date().toISOString()
    }, { onConflict: "seller_id,data_source" })
    .select("*")
    .single<DataFreshnessStatusRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not mark data freshness.");
  return toSafeStatus(data);
}

export async function checkDataFreshness(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  rows: SafeDataFreshnessStatus[];
  warnings: string[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const rows: SafeDataFreshnessStatus[] = [];
  for (const config of SOURCE_CONFIGS) {
    rows.push(await markDataFreshness(await deriveSourceStatus(sellerId, config)));
  }

  const warnings = rows
    .filter((row) => row.status === "STALE" || row.status === "ERROR")
    .map((row) => `${row.dataSource} is ${row.status}.`);

  return { ok: true, sellerId, rows, warnings };
}

export async function listDataFreshnessStatuses(sellerIdInput: string): Promise<SafeDataFreshnessStatus[]> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("data_freshness_status")
    .select("*")
    .eq("seller_id", sellerId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as DataFreshnessStatusRow[]).map(toSafeStatus);
}

export async function getDataFreshnessSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalSources: number;
  freshSources: number;
  staleSources: number;
  unknownSources: number;
  errorSources: number;
  warnings: string[];
  rows: SafeDataFreshnessStatus[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const rows = await listDataFreshnessStatuses(sellerId);
  const sourceStatus = new Map(rows.map((row) => [row.dataSource, row]));
  const completeRows = DATA_FRESHNESS_SOURCES.map((source) => sourceStatus.get(source)).filter((row): row is SafeDataFreshnessStatus => Boolean(row));
  const freshSources = completeRows.filter((row) => row.status === "FRESH").length;
  const staleSources = completeRows.filter((row) => row.status === "STALE").length;
  const unknownSources = DATA_FRESHNESS_SOURCES.length - completeRows.length + completeRows.filter((row) => row.status === "UNKNOWN").length;
  const errorSources = completeRows.filter((row) => row.status === "ERROR").length;
  const warnings = completeRows
    .filter((row) => row.status === "STALE" || row.status === "ERROR")
    .map((row) => `${row.dataSource} is ${row.status}.`);

  return {
    ok: true,
    sellerId,
    totalSources: DATA_FRESHNESS_SOURCES.length,
    freshSources,
    staleSources,
    unknownSources,
    errorSources,
    warnings,
    rows: completeRows
  };
}

export function isDataFreshnessSource(value: string): value is DataFreshnessSource {
  return DATA_FRESHNESS_SOURCES.includes(value as DataFreshnessSource);
}

export function isDataFreshnessStatus(value: string): value is DataFreshnessStatusValue {
  return ["FRESH", "STALE", "UNKNOWN", "ERROR"].includes(value);
}

export function getCriticalDataSourceSet(): Set<DataFreshnessSource> {
  return new Set(SOURCE_CONFIGS.filter((config) => config.critical).map((config) => config.dataSource));
}
