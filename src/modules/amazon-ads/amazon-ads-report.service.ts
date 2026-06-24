import axios from "axios";
import zlib from "zlib";
import { supabase } from "../../db/supabase";
import { retry } from "../../utils/retry";
import { logAmazonAdsApiCall, logSafeAmazonAdsSupabaseError } from "./amazon-ads-client.service";
import {
  AmazonAdsDashboardSummary,
  AmazonAdsSearchTermSummary,
  AmazonAdsSearchTermSummaryRow,
  AmazonAdsConnection,
  AmazonAdsRegion,
  AmazonAdsReportJob,
  SafeAmazonAdsCampaignDailyMetric,
  SafeAmazonAdsSearchTermDailyMetric
} from "./amazon-ads.types";

const AMAZON_ADS_API_ENDPOINTS: Record<AmazonAdsRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com"
};

type CreateReportResponse = {
  reportId?: string;
  report_id?: string;
  status?: string;
};

type ReportStatusResponse = {
  reportId?: string;
  report_id?: string;
  status?: string;
  url?: string;
  location?: string;
  failureReason?: string;
  failure_reason?: string;
};

type RawCampaignMetricRow = {
  date?: string;
  campaignId?: string | number;
  campaignName?: string;
  impressions?: string | number;
  clicks?: string | number;
  cost?: string | number;
  purchases14d?: string | number;
  sales14d?: string | number;
};

type RawSearchTermMetricRow = RawCampaignMetricRow & {
  adGroupId?: string | number;
  adGroupName?: string;
  keywordId?: string | number;
  keyword?: string;
  matchType?: string;
  targeting?: string;
  searchTerm?: string;
};

type CampaignMetricRow = {
  campaign_id: string;
  campaign_name: string | null;
  report_date: string;
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
  acos: number | null;
  roas: number | null;
  cpc: number | null;
  ctr: number | null;
  conversion_rate: number | null;
  last_synced_at: string | null;
};

type SearchTermMetricRow = CampaignMetricRow & {
  ad_group_id: string;
  ad_group_name: string | null;
  keyword_id: string | null;
  keyword: string | null;
  match_type: string | null;
  targeting: string | null;
  search_term: string;
};

type SearchTermSummaryMetricRow = {
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  search_term: string;
  impressions: number | string | null;
  clicks: number | string | null;
  cost: number | string | null;
  sales: number | string | null;
  orders: number | string | null;
};

type DashboardMetricRow = {
  campaign_id: string;
  campaign_name: string | null;
  report_date: string;
  impressions: number | string | null;
  clicks: number | string | null;
  cost: number | string | null;
  sales: number | string | null;
  orders: number | string | null;
};

type MetricAccumulator = {
  impressions: number;
  clicks: number;
  cost: number;
  sales: number;
  orders: number;
};

type AggregatableMetricRow = {
  impressions: number | string | null;
  clicks: number | string | null;
  cost: number | string | null;
  sales: number | string | null;
  orders: number | string | null;
};

const ACTIVE_REPORT_STATUSES = ["REQUESTED", "PENDING", "PROCESSING", "IN_PROGRESS", "COMPLETED"];
const FINISHED_REPORT_STATUSES = ["DOWNLOADED", "SYNCED", "FAILED", "FAILURE", "CANCELLED", "CANCELED"];

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function safeDivide(numerator: number, denominator: number, multiplier = 1): number | null {
  if (denominator <= 0) {
    return null;
  }

  return (numerator / denominator) * multiplier;
}

function parseGzipJsonRows(buffer: Buffer): RawCampaignMetricRow[] {
  const decompressed = zlib.gunzipSync(buffer).toString("utf8").trim();

  if (!decompressed) {
    return [];
  }

  try {
    const parsed = JSON.parse(decompressed) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.filter((row): row is RawCampaignMetricRow => Boolean(row) && typeof row === "object");
    }

    if (parsed && typeof parsed === "object") {
      const rows = (parsed as Record<string, unknown>).rows ?? (parsed as Record<string, unknown>).data;
      if (Array.isArray(rows)) {
        return rows.filter((row): row is RawCampaignMetricRow => Boolean(row) && typeof row === "object");
      }
    }
  } catch {
    return decompressed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RawCampaignMetricRow);
  }

  return [];
}

function parseGzipJsonSearchTermRows(buffer: Buffer): RawSearchTermMetricRow[] {
  return parseGzipJsonRows(buffer) as RawSearchTermMetricRow[];
}

function toMetricInsertRow(input: {
  row: RawCampaignMetricRow;
  connectionId: string;
  profileId: string;
  sellerId: string;
  fallbackDate: string;
  syncedAt: string;
}) {
  const reportDate = input.row.date ?? input.fallbackDate;
  const campaignId = String(input.row.campaignId ?? "");
  const impressions = toNumber(input.row.impressions);
  const clicks = toNumber(input.row.clicks);
  const cost = toNumber(input.row.cost);
  const orders = toNumber(input.row.purchases14d);
  const sales = toNumber(input.row.sales14d);

  return {
    connection_id: input.connectionId,
    profile_id: input.profileId,
    seller_id: input.sellerId,
    campaign_id: campaignId,
    campaign_name: input.row.campaignName ?? null,
    report_date: reportDate,
    impressions,
    clicks,
    cost,
    sales,
    orders,
    acos: safeDivide(cost, sales, 100),
    roas: safeDivide(sales, cost),
    cpc: safeDivide(cost, clicks),
    ctr: safeDivide(clicks, impressions, 100),
    conversion_rate: safeDivide(orders, clicks, 100),
    raw_data: input.row,
    last_synced_at: input.syncedAt,
    updated_at: input.syncedAt
  };
}

function toSearchTermMetricInsertRow(input: {
  row: RawSearchTermMetricRow;
  connectionId: string;
  profileId: string;
  sellerId: string;
  fallbackDate: string;
  syncedAt: string;
}) {
  const base = toMetricInsertRow(input);

  return {
    ...base,
    ad_group_id: String(input.row.adGroupId ?? ""),
    ad_group_name: input.row.adGroupName ?? null,
    keyword_id: input.row.keywordId == null ? null : String(input.row.keywordId),
    keyword: input.row.keyword ?? null,
    match_type: input.row.matchType ?? null,
    targeting: input.row.targeting ?? null,
    search_term: input.row.searchTerm ?? ""
  };
}

function toSafeMetric(row: CampaignMetricRow): SafeAmazonAdsCampaignDailyMetric {
  return {
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    reportDate: row.report_date,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    sales: row.sales,
    orders: row.orders,
    acos: row.acos,
    roas: row.roas,
    cpc: row.cpc,
    ctr: row.ctr,
    conversionRate: row.conversion_rate,
    lastSyncedAt: row.last_synced_at
  };
}

function toSafeSearchTermMetric(row: SearchTermMetricRow): SafeAmazonAdsSearchTermDailyMetric {
  return {
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    keywordId: row.keyword_id,
    keyword: row.keyword,
    matchType: row.match_type,
    targeting: row.targeting,
    searchTerm: row.search_term,
    reportDate: row.report_date,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    sales: row.sales,
    orders: row.orders,
    acos: row.acos,
    roas: row.roas,
    cpc: row.cpc,
    ctr: row.ctr,
    conversionRate: row.conversion_rate,
    lastSyncedAt: row.last_synced_at
  };
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function createAccumulator(): MetricAccumulator {
  return {
    impressions: 0,
    clicks: 0,
    cost: 0,
    sales: 0,
    orders: 0
  };
}

function addMetricRow(accumulator: MetricAccumulator, row: AggregatableMetricRow): void {
  accumulator.impressions += toNumber(row.impressions);
  accumulator.clicks += toNumber(row.clicks);
  accumulator.cost += toNumber(row.cost);
  accumulator.sales += toNumber(row.sales);
  accumulator.orders += toNumber(row.orders);
}

function summarizeAccumulator(accumulator: MetricAccumulator) {
  return {
    impressions: roundTwo(accumulator.impressions),
    clicks: roundTwo(accumulator.clicks),
    cost: roundTwo(accumulator.cost),
    sales: roundTwo(accumulator.sales),
    orders: roundTwo(accumulator.orders),
    ctr: roundTwo(safeDivide(accumulator.clicks, accumulator.impressions, 100) ?? 0),
    cpc: roundTwo(safeDivide(accumulator.cost, accumulator.clicks) ?? 0),
    acos:
      accumulator.sales > 0
        ? roundTwo(safeDivide(accumulator.cost, accumulator.sales, 100) ?? 0)
        : null,
    roas:
      accumulator.cost > 0
        ? roundTwo(safeDivide(accumulator.sales, accumulator.cost) ?? 0)
        : null,
    conversionRate: roundTwo(safeDivide(accumulator.orders, accumulator.clicks, 100) ?? 0)
  };
}

export async function requestSponsoredProductsCampaignReport(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  connectionId: string;
  sellerId: string;
  date: string;
}): Promise<{ jobId: string; reportId: string; status: string }> {
  const endpoint = "/reporting/reports";
  const body = {
    name: `SP campaign daily performance ${input.date}`,
    startDate: input.date,
    endDate: input.date,
    configuration: {
      adProduct: "SPONSORED_PRODUCTS",
      reportTypeId: "spCampaigns",
      groupBy: ["campaign"],
      timeUnit: "DAILY",
      format: "GZIP_JSON",
      columns: [
        "date",
        "campaignId",
        "campaignName",
        "impressions",
        "clicks",
        "cost",
        "purchases14d",
        "sales14d"
      ]
    }
  };

  const response = await retry(() =>
    axios.post<CreateReportResponse>(`${AMAZON_ADS_API_ENDPOINTS[input.region]}${endpoint}`, body, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
        "Amazon-Advertising-API-Scope": input.profileId,
        "Content-Type": "application/vnd.createasyncreportrequest.v3+json",
        Accept: "application/vnd.createasyncreportresponse.v3+json"
      }
    })
  );

  await logAmazonAdsApiCall({
    connectionId: input.connectionId,
    endpoint,
    method: "POST",
    statusCode: response.status,
    success: true
  });

  const reportId = response.data.reportId ?? response.data.report_id;

  if (!reportId) {
    throw new Error("Amazon Ads did not return a reportId.");
  }

  const status = response.data.status ?? "PENDING";
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .insert({
      connection_id: input.connectionId,
      profile_id: input.profileId,
      seller_id: input.sellerId,
      report_id: reportId,
      report_type: "spCampaigns",
      ad_product: "SPONSORED_PRODUCTS",
      start_date: input.date,
      end_date: input.date,
      status,
      requested_at: new Date().toISOString()
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    if (error) {
      logSafeAmazonAdsSupabaseError("Could not save Amazon Ads report job.", error);
    }
    throw new Error("Could not save Amazon Ads report job.");
  }

  return {
    jobId: data.id,
    reportId,
    status
  };
}

export async function requestSponsoredProductsSearchTermReport(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  connectionId: string;
  sellerId: string;
  date: string;
}): Promise<{ jobId: string; reportId: string; status: string }> {
  const endpoint = "/reporting/reports";
  const body = {
    name: `SP search term daily performance ${input.date}`,
    startDate: input.date,
    endDate: input.date,
    configuration: {
      adProduct: "SPONSORED_PRODUCTS",
      reportTypeId: "spSearchTerm",
      groupBy: ["searchTerm"],
      timeUnit: "DAILY",
      format: "GZIP_JSON",
      columns: [
        "date",
        "campaignId",
        "campaignName",
        "adGroupId",
        "adGroupName",
        "keywordId",
        "keyword",
        "matchType",
        "targeting",
        "searchTerm",
        "impressions",
        "clicks",
        "cost",
        "purchases14d",
        "sales14d"
      ]
    }
  };

  const response = await retry(() =>
    axios.post<CreateReportResponse>(`${AMAZON_ADS_API_ENDPOINTS[input.region]}${endpoint}`, body, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
        "Amazon-Advertising-API-Scope": input.profileId,
        "Content-Type": "application/vnd.createasyncreportrequest.v3+json",
        Accept: "application/vnd.createasyncreportresponse.v3+json"
      }
    })
  );

  await logAmazonAdsApiCall({
    connectionId: input.connectionId,
    endpoint,
    method: "POST",
    statusCode: response.status,
    success: true
  });

  const reportId = response.data.reportId ?? response.data.report_id;

  if (!reportId) {
    throw new Error("Amazon Ads did not return a reportId.");
  }

  const status = response.data.status ?? "PENDING";
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .insert({
      connection_id: input.connectionId,
      profile_id: input.profileId,
      seller_id: input.sellerId,
      report_id: reportId,
      report_type: "spSearchTerm",
      ad_product: "SPONSORED_PRODUCTS",
      start_date: input.date,
      end_date: input.date,
      status,
      requested_at: new Date().toISOString()
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    if (error) {
      logSafeAmazonAdsSupabaseError("Could not save Amazon Ads search term report job.", error);
    }
    throw new Error("Could not save Amazon Ads search term report job.");
  }

  return {
    jobId: data.id,
    reportId,
    status
  };
}

export async function hasCampaignMetricsForDate(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  date: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("amazon_ads_campaign_daily_metrics")
    .select("campaign_id")
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_date", input.date)
    .limit(1)
    .maybeSingle<{ campaign_id: string }>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not check existing Amazon Ads campaign metrics.", error);
    throw new Error("Could not check existing Amazon Ads campaign metrics.");
  }

  return Boolean(data);
}

export async function hasActiveCampaignReportJobForDate(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  date: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .select("id, status")
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_type", "spCampaigns")
    .eq("start_date", input.date)
    .eq("end_date", input.date);

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not check existing Amazon Ads report jobs.", error);
    throw new Error("Could not check existing Amazon Ads report jobs.");
  }

  return (data ?? []).some((job) => ACTIVE_REPORT_STATUSES.includes(String(job.status).toUpperCase()));
}

export async function hasCampaignReportJobForDate(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  date: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .select("id")
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_type", "spCampaigns")
    .eq("start_date", input.date)
    .eq("end_date", input.date)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not check Amazon Ads report job for date.", error);
    throw new Error("Could not check existing Amazon Ads report jobs.");
  }

  return Boolean(data);
}

export async function hasSearchTermMetricsForDate(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  date: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("amazon_ads_search_term_daily_metrics")
    .select("search_term")
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_date", input.date)
    .limit(1)
    .maybeSingle<{ search_term: string }>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not check existing Amazon Ads search term metrics.", error);
    throw new Error("Could not check existing Amazon Ads search term metrics.");
  }

  return Boolean(data);
}

export async function hasSearchTermReportJobForDate(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  date: string;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .select("id")
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_type", "spSearchTerm")
    .eq("start_date", input.date)
    .eq("end_date", input.date)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not check Amazon Ads search term report job for date.", error);
    throw new Error("Could not check existing Amazon Ads search term report jobs.");
  }

  return Boolean(data);
}

export async function loadAmazonAdsReportJob(jobId: string): Promise<AmazonAdsReportJob> {
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .select(
      "id, connection_id, profile_id, seller_id, report_id, report_type, ad_product, start_date, end_date, status, report_url, failure_reason, requested_at, completed_at"
    )
    .eq("id", jobId)
    .single<AmazonAdsReportJob>();

  if (error || !data) {
    if (error) {
      logSafeAmazonAdsSupabaseError("Could not load Amazon Ads report job.", error);
    }
    throw new Error("Amazon Ads report job was not found.");
  }

  return data;
}

export async function listProcessableCampaignReportJobs(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  limit: number;
}): Promise<AmazonAdsReportJob[]> {
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .select(
      "id, connection_id, profile_id, seller_id, report_id, report_type, ad_product, start_date, end_date, status, report_url, failure_reason, requested_at, completed_at"
    )
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_type", "spCampaigns")
    .order("requested_at", { ascending: false })
    .limit(Math.max(input.limit * 3, input.limit));

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not list Amazon Ads report jobs.", error);
    throw new Error("Could not list Amazon Ads report jobs.");
  }

  return ((data ?? []) as AmazonAdsReportJob[])
    .filter((job) => !FINISHED_REPORT_STATUSES.includes(job.status.toUpperCase()))
    .slice(0, input.limit);
}

export async function listProcessableSearchTermReportJobs(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  limit: number;
}): Promise<AmazonAdsReportJob[]> {
  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .select(
      "id, connection_id, profile_id, seller_id, report_id, report_type, ad_product, start_date, end_date, status, report_url, failure_reason, requested_at, completed_at"
    )
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .eq("report_type", "spSearchTerm")
    .order("requested_at", { ascending: false })
    .limit(Math.max(input.limit * 3, input.limit));

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not list Amazon Ads search term report jobs.", error);
    throw new Error("Could not list Amazon Ads search term report jobs.");
  }

  return ((data ?? []) as AmazonAdsReportJob[])
    .filter((job) => !FINISHED_REPORT_STATUSES.includes(job.status.toUpperCase()))
    .slice(0, input.limit);
}

export async function loadAmazonAdsConnectionById(connectionId: string): Promise<AmazonAdsConnection> {
  const { data, error } = await supabase
    .from("amazon_ads_connections")
    .select("*")
    .eq("id", connectionId)
    .single<AmazonAdsConnection>();

  if (error || !data) {
    if (error) {
      logSafeAmazonAdsSupabaseError("Could not load Amazon Ads connection for report job.", error);
    }
    throw new Error("Amazon Ads connection was not found.");
  }

  return data;
}

export async function refreshAmazonAdsReportJobStatus(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  job: AmazonAdsReportJob;
}): Promise<AmazonAdsReportJob> {
  const endpoint = `/reporting/reports/${input.job.report_id}`;
  const response = await retry(() =>
    axios.get<ReportStatusResponse>(`${AMAZON_ADS_API_ENDPOINTS[input.region]}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Amazon-Advertising-API-ClientId": process.env.AMAZON_ADS_CLIENT_ID ?? "",
        "Amazon-Advertising-API-Scope": input.job.profile_id,
        Accept: "application/vnd.getasyncreportresponse.v3+json"
      }
    })
  );

  await logAmazonAdsApiCall({
    connectionId: input.job.connection_id,
    endpoint,
    method: "GET",
    statusCode: response.status,
    success: true
  });

  const status = response.data.status ?? input.job.status;
  const reportUrl = response.data.url ?? response.data.location ?? input.job.report_url;
  const failureReason = response.data.failureReason ?? response.data.failure_reason ?? input.job.failure_reason;
  const completedAt =
    status.toUpperCase() === "COMPLETED" && !input.job.completed_at
      ? new Date().toISOString()
      : input.job.completed_at;

  const { data, error } = await supabase
    .from("amazon_ads_report_jobs")
    .update({
      status,
      report_url: reportUrl ?? null,
      failure_reason: failureReason ?? null,
      completed_at: completedAt
    })
    .eq("id", input.job.id)
    .select(
      "id, connection_id, profile_id, seller_id, report_id, report_type, ad_product, start_date, end_date, status, report_url, failure_reason, requested_at, completed_at"
    )
    .single<AmazonAdsReportJob>();

  if (error || !data) {
    if (error) {
      logSafeAmazonAdsSupabaseError("Could not update Amazon Ads report job.", error);
    }
    throw new Error("Could not update Amazon Ads report job.");
  }

  return data;
}

export async function downloadAndSaveCampaignReport(job: AmazonAdsReportJob): Promise<number> {
  if (job.status.toUpperCase() !== "COMPLETED" || !job.report_url) {
    return 0;
  }

  const response = await axios.get<ArrayBuffer>(job.report_url, {
    responseType: "arraybuffer"
  });
  const rows = parseGzipJsonRows(Buffer.from(response.data));
  const syncedAt = new Date().toISOString();
  const insertRows = rows
    .map((row) =>
      toMetricInsertRow({
        row,
        connectionId: job.connection_id,
        profileId: job.profile_id,
        sellerId: job.seller_id ?? "default",
        fallbackDate: job.start_date,
        syncedAt
      })
    )
    .filter((row) => row.campaign_id.length > 0);

  if (insertRows.length === 0) {
    return 0;
  }

  const { error } = await supabase.from("amazon_ads_campaign_daily_metrics").upsert(insertRows, {
    onConflict: "profile_id,campaign_id,report_date"
  });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not save Amazon Ads campaign daily metrics.", error);
    throw new Error("Could not save Amazon Ads campaign daily metrics.");
  }

  return insertRows.length;
}

export async function downloadAndSaveSearchTermReport(job: AmazonAdsReportJob): Promise<number> {
  if (job.report_type !== "spSearchTerm") {
    throw new Error("This report job is not a Sponsored Products search term report.");
  }

  if (job.status.toUpperCase() !== "COMPLETED" || !job.report_url) {
    return 0;
  }

  const response = await axios.get<ArrayBuffer>(job.report_url, {
    responseType: "arraybuffer"
  });
  const rows = parseGzipJsonSearchTermRows(Buffer.from(response.data));
  const syncedAt = new Date().toISOString();
  const insertRows = rows
    .map((row) =>
      toSearchTermMetricInsertRow({
        row,
        connectionId: job.connection_id,
        profileId: job.profile_id,
        sellerId: job.seller_id ?? "default",
        fallbackDate: job.start_date,
        syncedAt
      })
    )
    .filter((row) => row.campaign_id.length > 0 && row.ad_group_id.length > 0 && row.search_term.length > 0);

  if (insertRows.length === 0) {
    return 0;
  }

  const { error } = await supabase.from("amazon_ads_search_term_daily_metrics").upsert(insertRows, {
    onConflict: "profile_id,report_date,campaign_id,ad_group_id,search_term"
  });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not save Amazon Ads search term daily metrics.", error);
    throw new Error("Could not save Amazon Ads search term daily metrics.");
  }

  return insertRows.length;
}

export async function markAmazonAdsReportJobSynced(jobId: string): Promise<void> {
  const { error } = await supabase
    .from("amazon_ads_report_jobs")
    .update({
      status: "SYNCED",
      completed_at: new Date().toISOString()
    })
    .eq("id", jobId);

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not mark Amazon Ads report job as synced.", error);
    throw new Error("Could not mark Amazon Ads report job as synced.");
  }
}

export async function listCampaignDailyMetrics(input: {
  connectionId: string;
  profileId: string;
  date?: string;
}): Promise<{ date: string | null; metrics: SafeAmazonAdsCampaignDailyMetric[] }> {
  let reportDate = input.date;

  if (!reportDate) {
    const { data: latest, error: latestError } = await supabase
      .from("amazon_ads_campaign_daily_metrics")
      .select("report_date")
      .eq("connection_id", input.connectionId)
      .eq("profile_id", input.profileId)
      .order("report_date", { ascending: false })
      .limit(1)
      .maybeSingle<{ report_date: string }>();

    if (latestError) {
      logSafeAmazonAdsSupabaseError("Could not find latest Amazon Ads campaign metrics date.", latestError);
      throw new Error("Could not load Amazon Ads campaign daily metrics.");
    }

    reportDate = latest?.report_date;
  }

  if (!reportDate) {
    return {
      date: null,
      metrics: []
    };
  }

  const { data, error } = await supabase
    .from("amazon_ads_campaign_daily_metrics")
    .select(
      "campaign_id, campaign_name, report_date, impressions, clicks, cost, sales, orders, acos, roas, cpc, ctr, conversion_rate, last_synced_at"
    )
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("report_date", reportDate)
    .order("campaign_name", { ascending: true });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load Amazon Ads campaign daily metrics.", error);
    throw new Error("Could not load Amazon Ads campaign daily metrics.");
  }

  return {
    date: reportDate,
    metrics: ((data ?? []) as CampaignMetricRow[]).map(toSafeMetric)
  };
}

export async function listSearchTermDailyMetrics(input: {
  connectionId: string;
  profileId: string;
  date?: string;
}): Promise<{ date: string | null; metrics: SafeAmazonAdsSearchTermDailyMetric[] }> {
  let reportDate = input.date;

  if (!reportDate) {
    const { data: latest, error: latestError } = await supabase
      .from("amazon_ads_search_term_daily_metrics")
      .select("report_date")
      .eq("connection_id", input.connectionId)
      .eq("profile_id", input.profileId)
      .order("report_date", { ascending: false })
      .limit(1)
      .maybeSingle<{ report_date: string }>();

    if (latestError) {
      logSafeAmazonAdsSupabaseError("Could not find latest Amazon Ads search term metrics date.", latestError);
      throw new Error("Could not load Amazon Ads search term daily metrics.");
    }

    reportDate = latest?.report_date;
  }

  if (!reportDate) {
    return {
      date: null,
      metrics: []
    };
  }

  const { data, error } = await supabase
    .from("amazon_ads_search_term_daily_metrics")
    .select(
      "campaign_id, campaign_name, ad_group_id, ad_group_name, keyword_id, keyword, match_type, targeting, search_term, report_date, impressions, clicks, cost, sales, orders, acos, roas, cpc, ctr, conversion_rate, last_synced_at"
    )
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("report_date", reportDate)
    .order("cost", { ascending: false });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load Amazon Ads search term daily metrics.", error);
    throw new Error("Could not load Amazon Ads search term daily metrics.");
  }

  return {
    date: reportDate,
    metrics: ((data ?? []) as SearchTermMetricRow[]).map(toSafeSearchTermMetric)
  };
}

function isAsinSearchTerm(searchTerm: string): boolean {
  return /^B[A-Z0-9]{9}$/i.test(searchTerm.trim());
}

function toSearchTermSummaryRow(
  accumulator: MetricAccumulator & {
    searchTerm: string;
    campaignId: string;
    campaignName: string | null;
    adGroupId: string;
    adGroupName: string | null;
  }
): AmazonAdsSearchTermSummaryRow {
  return {
    searchTerm: accumulator.searchTerm,
    campaignId: accumulator.campaignId,
    campaignName: accumulator.campaignName,
    adGroupId: accumulator.adGroupId,
    adGroupName: accumulator.adGroupName,
    ...summarizeAccumulator(accumulator)
  };
}

export async function getSearchTermSummary(input: {
  sellerId: string;
  days: number;
}): Promise<AmazonAdsSearchTermSummary> {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - (input.days - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("amazon_ads_search_term_daily_metrics")
    .select(
      "campaign_id, campaign_name, ad_group_id, ad_group_name, search_term, impressions, clicks, cost, sales, orders"
    )
    .eq("seller_id", input.sellerId)
    .gte("report_date", startDate)
    .lte("report_date", endDate);

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load Amazon Ads search term summary metrics.", error);
    throw new Error("Could not load Amazon Ads search term summary.");
  }

  const totalsAccumulator = createAccumulator();
  const grouped = new Map<
    string,
    MetricAccumulator & {
      searchTerm: string;
      campaignId: string;
      campaignName: string | null;
      adGroupId: string;
      adGroupName: string | null;
    }
  >();

  for (const row of (data ?? []) as SearchTermSummaryMetricRow[]) {
    addMetricRow(totalsAccumulator, row);

    const searchTerm = row.search_term;
    const campaignId = row.campaign_id;
    const adGroupId = row.ad_group_id;
    const key = `${searchTerm}::${campaignId}::${adGroupId}`;
    const accumulator =
      grouped.get(key) ??
      {
        ...createAccumulator(),
        searchTerm,
        campaignId,
        campaignName: row.campaign_name,
        adGroupId,
        adGroupName: row.ad_group_name
      };

    addMetricRow(accumulator, row);
    accumulator.campaignName = accumulator.campaignName ?? row.campaign_name;
    accumulator.adGroupName = accumulator.adGroupName ?? row.ad_group_name;
    grouped.set(key, accumulator);
  }

  const rows = Array.from(grouped.values()).map((accumulator) => toSearchTermSummaryRow(accumulator));

  return {
    totals: summarizeAccumulator(totalsAccumulator),
    wastedSearchTerms: rows
      .filter((row) => row.cost > 0 && row.sales === 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 50),
    convertingSearchTerms: rows
      .filter((row) => row.orders > 0 || row.sales > 0)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 50),
    highClickNoSaleTerms: rows
      .filter((row) => row.clicks >= 5 && row.sales === 0)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 50),
    asinSearchTerms: rows
      .filter((row) => isAsinSearchTerm(row.searchTerm))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 50),
    topSpendTerms: [...rows].sort((a, b) => b.cost - a.cost).slice(0, 50)
  };
}

export async function getCampaignDashboardSummary(input: {
  connectionId: string;
  profileId: string;
  sellerId: string;
  days: number;
}): Promise<AmazonAdsDashboardSummary> {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - (input.days - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("amazon_ads_campaign_daily_metrics")
    .select("campaign_id, campaign_name, report_date, impressions, clicks, cost, sales, orders")
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .eq("seller_id", input.sellerId)
    .gte("report_date", startDate)
    .lte("report_date", endDate)
    .order("report_date", { ascending: true });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load Amazon Ads dashboard summary metrics.", error);
    throw new Error("Could not load Amazon Ads dashboard summary.");
  }

  const rows = (data ?? []) as DashboardMetricRow[];
  const totalsAccumulator = createAccumulator();
  const dailyMap = new Map<string, MetricAccumulator>();
  const campaignMap = new Map<string, MetricAccumulator & { campaignId: string; campaignName: string | null }>();
  let zeroSalesSpend = 0;

  for (const row of rows) {
    addMetricRow(totalsAccumulator, row);

    const dailyAccumulator = dailyMap.get(row.report_date) ?? createAccumulator();
    addMetricRow(dailyAccumulator, row);
    dailyMap.set(row.report_date, dailyAccumulator);

    const campaignAccumulator =
      campaignMap.get(row.campaign_id) ??
      {
        ...createAccumulator(),
        campaignId: row.campaign_id,
        campaignName: row.campaign_name
      };
    addMetricRow(campaignAccumulator, row);
    campaignAccumulator.campaignName = campaignAccumulator.campaignName ?? row.campaign_name;
    campaignMap.set(row.campaign_id, campaignAccumulator);

    const rowSales = toNumber(row.sales);
    const rowCost = toNumber(row.cost);
    if (rowSales <= 0 && rowCost > 0) {
      zeroSalesSpend += rowCost;
    }
  }

  const dailyTrend = Array.from(dailyMap.entries()).map(([date, accumulator]) => ({
    date,
    ...summarizeAccumulator(accumulator)
  }));
  const campaigns = Array.from(campaignMap.values())
    .map((accumulator) => ({
      campaignId: accumulator.campaignId,
      campaignName: accumulator.campaignName,
      ...summarizeAccumulator(accumulator)
    }))
    .sort((a, b) => b.cost - a.cost);

  const bestCampaignByClicks =
    campaigns.length > 0
      ? campaigns.reduce((best, campaign) => (campaign.clicks > best.clicks ? campaign : best), campaigns[0])
      : null;
  const highestSpendCampaign =
    campaigns.length > 0
      ? campaigns.reduce((highest, campaign) => (campaign.cost > highest.cost ? campaign : highest), campaigns[0])
      : null;

  return {
    dateRange: {
      startDate,
      endDate
    },
    totals: summarizeAccumulator(totalsAccumulator),
    dailyTrend,
    campaigns,
    bestCampaignByClicks,
    highestSpendCampaign,
    zeroSalesSpend: roundTwo(zeroSalesSpend)
  };
}
