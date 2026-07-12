import { supabase } from "../../db/supabase";
import { generateAlerts } from "../alert-center/alert-center.service";
import { checkDataFreshness } from "../data-freshness/data-freshness.service";
import { rebuildLearningSummaries } from "../learning-loop/learning-loop.service";
import { runMaintenance } from "../maintenance/maintenance.service";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { runQaSmokeTest } from "../qa-smoke/qa-smoke.service";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { SchedulerJobRow, SchedulerJobRunRow, SafeSchedulerJob, SafeSchedulerJobRun } from "./scheduler-control.types";

const DEFAULT_JOBS = [
  { jobKey: "DAILY_SP_API_SYNC", jobName: "Daily SP-API Sync", jobType: "SYNC", scheduleHint: "daily" },
  { jobKey: "DAILY_AMAZON_ADS_SYNC", jobName: "Daily Amazon Ads Sync", jobType: "SYNC", scheduleHint: "daily" },
  { jobKey: "DAILY_AI_CGO", jobName: "Daily AI-CGO", jobType: "ORCHESTRATION", scheduleHint: "daily shadow" },
  { jobKey: "DAILY_MAINTENANCE", jobName: "Daily Maintenance", jobType: "MAINTENANCE", scheduleHint: "daily" },
  { jobKey: "DAILY_QA_SMOKE", jobName: "Daily QA Smoke", jobType: "QA", scheduleHint: "daily" },
  { jobKey: "DAILY_ALERT_GENERATION", jobName: "Daily Alert Generation", jobType: "ALERTS", scheduleHint: "daily" },
  { jobKey: "DAILY_DATA_FRESHNESS", jobName: "Daily Data Freshness", jobType: "DATA", scheduleHint: "daily" },
  { jobKey: "DAILY_LEARNING_REBUILD", jobName: "Daily Learning Rebuild", jobType: "LEARNING", scheduleHint: "daily" },
  { jobKey: "DAILY_PRODUCTION_HEALTH", jobName: "Daily Production Health", jobType: "HEALTH", scheduleHint: "daily" }
];

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSafeJob(row: SchedulerJobRow): SafeSchedulerJob {
  return {
    id: row.id,
    sellerId: row.seller_id,
    jobKey: row.job_key,
    jobName: row.job_name,
    jobType: row.job_type,
    enabled: Boolean(row.enabled),
    scheduleHint: row.schedule_hint,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunSummary: toJsonObject(row.last_run_summary),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeRun(row: SchedulerJobRunRow): SafeSchedulerJobRun {
  return {
    id: row.id,
    sellerId: row.seller_id,
    jobKey: row.job_key,
    runStatus: row.run_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: toJsonObject(row.result),
    errorMessage: row.error_message,
    createdAt: row.created_at
  };
}

export async function seedSchedulerJobs(sellerIdInput: string): Promise<{ ok: true; sellerId: string; count: number; jobs: SafeSchedulerJob[] }> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const rows = DEFAULT_JOBS.map((job) => ({
    seller_id: sellerId,
    job_key: job.jobKey,
    job_name: job.jobName,
    job_type: job.jobType,
    enabled: true,
    schedule_hint: job.scheduleHint,
    updated_at: new Date().toISOString()
  }));
  const { data, error } = await supabase
    .from("scheduler_jobs")
    .upsert(rows, { onConflict: "seller_id,job_key" })
    .select("*");
  if (error) throw new Error(error.message);
  return { ok: true, sellerId, count: data?.length ?? 0, jobs: ((data ?? []) as SchedulerJobRow[]).map(toSafeJob) };
}

export async function listSchedulerJobs(sellerIdInput: string): Promise<SafeSchedulerJob[]> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("scheduler_jobs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("job_key", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as SchedulerJobRow[]).map(toSafeJob);
}

async function getJob(sellerId: string, jobKey: string): Promise<SafeSchedulerJob | null> {
  const { data, error } = await supabase
    .from("scheduler_jobs")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("job_key", jobKey)
    .maybeSingle<SchedulerJobRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeJob(data) : null;
}

async function createRun(sellerId: string, jobKey: string): Promise<SafeSchedulerJobRun> {
  const { data, error } = await supabase
    .from("scheduler_job_runs")
    .insert({ seller_id: sellerId, job_key: jobKey, run_status: "RUNNING" })
    .select("*")
    .single<SchedulerJobRunRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not create scheduler job run.");
  return toSafeRun(data);
}

async function finishRun(runId: string, status: string, result: Record<string, unknown>, errorMessage?: string | null): Promise<SafeSchedulerJobRun> {
  const { data, error } = await supabase
    .from("scheduler_job_runs")
    .update({
      run_status: status,
      result,
      error_message: cleanText(errorMessage),
      finished_at: new Date().toISOString()
    })
    .eq("id", runId)
    .select("*")
    .single<SchedulerJobRunRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not finish scheduler job run.");
  return toSafeRun(data);
}

async function updateJobLastRun(sellerId: string, jobKey: string, status: string, result: Record<string, unknown>): Promise<void> {
  await supabase
    .from("scheduler_jobs")
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_run_summary: result,
      updated_at: new Date().toISOString()
    })
    .eq("seller_id", sellerId)
    .eq("job_key", jobKey);
}

async function runInternalJob(sellerId: string, jobKey: string): Promise<{ status: string; result: Record<string, unknown> }> {
  if (jobKey === "DAILY_SP_API_SYNC" || jobKey === "DAILY_AMAZON_ADS_SYNC") {
    return { status: "SKIPPED_NOT_IMPLEMENTED", result: { externalMutation: false, message: "Sync runner not implemented here; no external call made." } };
  }
  if (jobKey === "DAILY_AI_CGO") {
    return { status: "COMPLETED", result: { mode: "SHADOW", externalMutation: false, message: "Daily AI-CGO scheduler placeholder completed in shadow." } };
  }
  if (jobKey === "DAILY_MAINTENANCE") {
    const result = await runMaintenance({ sellerId, runType: "SCHEDULER" });
    return { status: result.ok ? "COMPLETED" : "FAILED", result: result as unknown as Record<string, unknown> };
  }
  if (jobKey === "DAILY_QA_SMOKE") {
    const result = await runQaSmokeTest(sellerId);
    return { status: result.ok ? "COMPLETED" : "FAILED", result: result as unknown as Record<string, unknown> };
  }
  if (jobKey === "DAILY_ALERT_GENERATION") {
    const result = await generateAlerts(sellerId);
    return { status: "COMPLETED", result: result as unknown as Record<string, unknown> };
  }
  if (jobKey === "DAILY_DATA_FRESHNESS") {
    const result = await checkDataFreshness(sellerId);
    return { status: "COMPLETED", result: result as unknown as Record<string, unknown> };
  }
  if (jobKey === "DAILY_LEARNING_REBUILD") {
    const result = await rebuildLearningSummaries(sellerId);
    return { status: "COMPLETED", result: result as unknown as Record<string, unknown> };
  }
  if (jobKey === "DAILY_PRODUCTION_HEALTH") {
    const result = await getProductionHealthSummary(sellerId);
    return { status: result.ok ? "COMPLETED" : "COMPLETED_WITH_WARNINGS", result: result as unknown as Record<string, unknown> };
  }
  return { status: "SKIPPED_NOT_IMPLEMENTED", result: { message: "Scheduler job is not implemented.", externalMutation: false } };
}

export async function runSchedulerJob(input: { sellerId: string; jobKey: string }): Promise<{
  ok: boolean;
  sellerId: string;
  jobKey: string;
  run: SafeSchedulerJobRun;
  message: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const jobKey = cleanText(input.jobKey)?.toUpperCase() ?? "";
  await seedSchedulerJobs(sellerId);
  const job = await getJob(sellerId, jobKey);
  if (!job) throw new Error("SCHEDULER_JOB_NOT_FOUND");
  const run = await createRun(sellerId, jobKey);

  if (!job.enabled) {
    const result = { message: "Scheduler job is disabled.", externalMutation: false };
    const finished = await finishRun(run.id, "SKIPPED_DISABLED", result);
    await updateJobLastRun(sellerId, jobKey, finished.runStatus, result);
    return { ok: false, sellerId, jobKey, run: finished, message: "Scheduler job is disabled." };
  }

  try {
    const result = await runInternalJob(sellerId, jobKey);
    const finished = await finishRun(run.id, result.status, result.result);
    await updateJobLastRun(sellerId, jobKey, result.status, result.result);
    await safeRecordActivityLog({
      sellerId,
      eventType: "SCHEDULER_JOB_RUN_COMPLETED",
      eventCategory: "SCHEDULER",
      severity: result.status === "FAILED" ? "ERROR" : result.status.includes("SKIPPED") ? "WARNING" : "SUCCESS",
      actor: "scheduler-control",
      title: "Scheduler job run completed",
      message: `${jobKey} completed with status ${result.status}.`,
      sourceModule: "scheduler-control",
      metadata: { jobKey, runId: finished.id, status: result.status, externalMutation: false }
    });
    return { ok: result.status !== "FAILED", sellerId, jobKey, run: finished, message: `${jobKey} completed with status ${result.status}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scheduler failure";
    const finished = await finishRun(run.id, "FAILED", { externalMutation: false }, message);
    await updateJobLastRun(sellerId, jobKey, "FAILED", { error: message });
    return { ok: false, sellerId, jobKey, run: finished, message };
  }
}

export async function updateSchedulerJob(input: {
  sellerId: string;
  jobKey: string;
  enabled?: boolean;
  scheduleHint?: string | null;
}): Promise<SafeSchedulerJob | null> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.enabled !== undefined) updateRow.enabled = input.enabled;
  if (input.scheduleHint !== undefined) updateRow.schedule_hint = cleanText(input.scheduleHint);
  const { data, error } = await supabase
    .from("scheduler_jobs")
    .update(updateRow)
    .eq("seller_id", sellerId)
    .eq("job_key", input.jobKey)
    .select("*")
    .maybeSingle<SchedulerJobRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeJob(data) : null;
}

export async function getSchedulerControlSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalJobs: number;
  enabledJobs: number;
  disabledJobs: number;
  latestRuns: SafeSchedulerJobRun[];
  jobs: SafeSchedulerJob[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const jobs = await listSchedulerJobs(sellerId).catch(() => []);
  const { data } = await supabase
    .from("scheduler_job_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("started_at", { ascending: false })
    .limit(10);
  return {
    ok: true,
    sellerId,
    totalJobs: jobs.length,
    enabledJobs: jobs.filter((job) => job.enabled).length,
    disabledJobs: jobs.filter((job) => !job.enabled).length,
    latestRuns: ((data ?? []) as SchedulerJobRunRow[]).map(toSafeRun),
    jobs
  };
}
