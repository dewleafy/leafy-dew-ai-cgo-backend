import { supabase } from "../../db/supabase";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { generateAlerts, seedDefaultAlertRules } from "../alert-center/alert-center.service";
import { checkDataFreshness } from "../data-freshness/data-freshness.service";
import { rebuildLearningSummaries } from "../learning-loop/learning-loop.service";
import { getProductionHealthSummary } from "../production-health/production-health.service";
import { initializeSafetyControl } from "../safety-control/safety-control.service";
import { MaintenanceRunRow, SafeMaintenanceRun } from "./maintenance.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toSafeRun(row: MaintenanceRunRow): SafeMaintenanceRun {
  return {
    id: row.id,
    sellerId: row.seller_id,
    runType: row.run_type,
    runStatus: row.run_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    safetyInitialized: Boolean(row.safety_initialized),
    alertRulesSeeded: Boolean(row.alert_rules_seeded),
    alertsGenerated: toNumber(row.alerts_generated),
    dataSourcesChecked: toNumber(row.data_sources_checked),
    learningRebuilt: Boolean(row.learning_rebuilt),
    healthStatus: row.health_status,
    warnings: toJsonArray(row.warnings),
    results: toJsonObject(row.results),
    errorMessage: row.error_message,
    createdAt: row.created_at
  };
}

async function createRun(sellerId: string, runType: string): Promise<SafeMaintenanceRun> {
  const { data, error } = await supabase
    .from("maintenance_runs")
    .insert({
      seller_id: sellerId,
      run_type: runType,
      run_status: "RUNNING",
      results: { shadowMode: true, externalExecution: false }
    })
    .select("*")
    .single<MaintenanceRunRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not create maintenance run.");
  return toSafeRun(data);
}

async function updateRun(runId: string, row: Record<string, unknown>): Promise<SafeMaintenanceRun> {
  const { data, error } = await supabase
    .from("maintenance_runs")
    .update(row)
    .eq("id", runId)
    .select("*")
    .single<MaintenanceRunRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not update maintenance run.");
  return toSafeRun(data);
}

export async function runMaintenance(input: {
  sellerId?: string | null;
  runType?: string | null;
}): Promise<{
  ok: boolean;
  sellerId: string;
  runId: string;
  runStatus: string;
  safetyInitialized: boolean;
  alertRulesSeeded: boolean;
  alertsGenerated: number;
  dataSourcesChecked: number;
  learningRebuilt: boolean;
  healthStatus: string | null;
  warnings: unknown[];
  message: string;
  results: Record<string, unknown>;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const runType = cleanText(input.runType) ?? "MANUAL";
  const run = await createRun(sellerId, runType);
  const warnings: string[] = [];
  const results: Record<string, unknown> = {
    shadowMode: true,
    externalExecution: false,
    aiCall: false
  };
  let safetyInitialized = false;
  let alertRulesSeeded = false;
  let alertsGenerated = 0;
  let dataSourcesChecked = 0;
  let learningRebuilt = false;
  let healthStatus: string | null = null;

  try {
    try {
      const safety = await initializeSafetyControl(sellerId, "maintenance");
      safetyInitialized = Boolean(safety.settings);
      results.safety = { created: safety.created, liveExecutionEnabled: false, aiCallsEnabled: false };
    } catch (error) {
      warnings.push(`Safety Control initialization warning: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    try {
      const seeded = await seedDefaultAlertRules(sellerId);
      alertRulesSeeded = seeded.count > 0;
      results.alertRules = { count: seeded.count };
    } catch (error) {
      warnings.push(`Alert rule seed warning: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    try {
      const alerts = await generateAlerts(sellerId);
      alertsGenerated = alerts.generatedCount;
      results.alerts = { generatedCount: alerts.generatedCount, skippedCount: alerts.skippedCount };
    } catch (error) {
      warnings.push(`Alert generation warning: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    try {
      const freshness = await checkDataFreshness(sellerId);
      dataSourcesChecked = freshness.rows.length;
      results.dataFreshness = { rows: freshness.rows.length, warnings: freshness.warnings };
      warnings.push(...freshness.warnings);
    } catch (error) {
      warnings.push(`Data freshness warning: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    try {
      const learning = await rebuildLearningSummaries(sellerId);
      learningRebuilt = true;
      results.learning = { eventsScanned: learning.eventsScanned, summariesUpserted: learning.summariesUpserted };
    } catch (error) {
      warnings.push(`Learning rebuild warning: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    try {
      const health = await getProductionHealthSummary(sellerId);
      healthStatus = health.overallStatus;
      results.productionHealth = {
        overallStatus: health.overallStatus,
        blockers: health.blockers,
        warnings: health.warnings
      };
      warnings.push(...health.warnings);
    } catch (error) {
      warnings.push(`Production Health warning: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const runStatus = warnings.length ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
    const updated = await updateRun(run.id, {
      run_status: runStatus,
      finished_at: new Date().toISOString(),
      safety_initialized: safetyInitialized,
      alert_rules_seeded: alertRulesSeeded,
      alerts_generated: alertsGenerated,
      data_sources_checked: dataSourcesChecked,
      learning_rebuilt: learningRebuilt,
      health_status: healthStatus,
      warnings: [...new Set(warnings)],
      results
    });

    await safeRecordActivityLog({
      sellerId,
      eventType: "MAINTENANCE_RUN_COMPLETED",
      eventCategory: "MAINTENANCE",
      severity: warnings.length ? "WARNING" : "SUCCESS",
      actor: "maintenance",
      title: "Maintenance run completed",
      message: "Maintenance run completed in shadow mode. No external action executed.",
      sourceModule: "maintenance",
      metadata: { runId: run.id, runStatus, warningsCount: warnings.length }
    });

    return {
      ok: true,
      sellerId,
      runId: updated.id,
      runStatus: updated.runStatus,
      safetyInitialized: updated.safetyInitialized,
      alertRulesSeeded: updated.alertRulesSeeded,
      alertsGenerated: updated.alertsGenerated,
      dataSourcesChecked: updated.dataSourcesChecked,
      learningRebuilt: updated.learningRebuilt,
      healthStatus: updated.healthStatus,
      warnings: updated.warnings,
      results: updated.results,
      message: "Maintenance run completed in shadow mode. No external action executed."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown maintenance failure";
    const failed = await updateRun(run.id, {
      run_status: "FAILED",
      finished_at: new Date().toISOString(),
      warnings,
      results,
      error_message: message
    }).catch(() => run);

    await safeRecordActivityLog({
      sellerId,
      eventType: "MAINTENANCE_RUN_FAILED",
      eventCategory: "MAINTENANCE",
      severity: "ERROR",
      actor: "maintenance",
      title: "Maintenance run failed safely",
      message,
      sourceModule: "maintenance",
      metadata: { runId: run.id }
    });

    return {
      ok: false,
      sellerId,
      runId: failed.id,
      runStatus: failed.runStatus,
      safetyInitialized,
      alertRulesSeeded,
      alertsGenerated,
      dataSourcesChecked,
      learningRebuilt,
      healthStatus,
      warnings,
      results,
      message: "Maintenance run failed safely. No external action executed."
    };
  }
}

export async function listMaintenanceRuns(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeMaintenanceRun[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
  const { data, error } = await supabase
    .from("maintenance_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return ((data ?? []) as MaintenanceRunRow[]).map(toSafeRun);
}

export async function getMaintenanceSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalRuns: number;
  latestRun: SafeMaintenanceRun | null;
  latestStatus: string | null;
  message: string;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [{ count, error }, runs] = await Promise.all([
    supabase.from("maintenance_runs").select("id", { count: "exact", head: true }).eq("seller_id", sellerId),
    listMaintenanceRuns({ sellerId, limit: 1 }).catch(() => [])
  ]);

  if (error) throw new Error(error.message);

  return {
    ok: true,
    sellerId,
    totalRuns: count ?? 0,
    latestRun: runs[0] ?? null,
    latestStatus: runs[0]?.runStatus ?? null,
    message: "Maintenance Runner is available. Runs are shadow-mode only."
  };
}
