import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  getEngineSeedCategoryCounts,
  getEngineSeedDefinitions
} from "./engine-registry.seed";
import {
  EngineDefinition,
  EngineRegistryListFilters,
  EngineRegistryRow,
  EngineRegistrySummary,
  EngineRunLogRow,
  EngineSeedResult,
  SafeEngineRegistryRow,
  SafeEngineRunLogRow
} from "./engine-registry.types";

function sanitizeErrorMessage(message: string): string {
  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.AMAZON_LWA_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_SECRET,
    env.ENCRYPTION_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (safeMessage, secretValue) => safeMessage.replaceAll(secretValue, "[REDACTED]"),
    message
  );
}

function logEngineRegistryError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countBy<T>(items: T[], getKey: (item: T) => string | null | undefined): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item) || "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function toSafeEngineRegistryRow(row: EngineRegistryRow): SafeEngineRegistryRow {
  return {
    id: row.id,
    engineKey: row.engine_key,
    engineName: row.engine_name,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    inputRequirements: asArray(row.input_requirements),
    dataSources: asArray(row.data_sources),
    ruleTemplate: row.rule_template,
    ruleConfig: toJsonObject(row.rule_config),
    outputActionType: row.output_action_type,
    outputEntityType: row.output_entity_type,
    riskLevel: row.risk_level,
    costLevel: row.cost_level,
    priorityScore: toNumber(row.priority_score),
    runFrequency: row.run_frequency,
    enabled: Boolean(row.enabled),
    shadowMode: Boolean(row.shadow_mode),
    requiresApproval: Boolean(row.requires_approval),
    ownerModule: row.owner_module,
    version: row.version,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunSummary: row.last_run_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeEngineRunLogRow(row: EngineRunLogRow): SafeEngineRunLogRow {
  return {
    id: row.id,
    engineKey: row.engine_key,
    sellerId: row.seller_id,
    runStatus: row.run_status,
    runType: row.run_type,
    inputSnapshot: row.input_snapshot,
    outputSnapshot: row.output_snapshot,
    actionsCreatedCount: row.actions_created_count,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    metadata: toJsonObject(row.metadata)
  };
}

function toUpsertRow(engine: EngineDefinition, updatedAt: string): Record<string, unknown> {
  return {
    engine_key: engine.engineKey,
    engine_name: engine.engineName,
    category: engine.category,
    subcategory: engine.subcategory,
    description: engine.description,
    input_requirements: engine.inputRequirements,
    data_sources: engine.dataSources,
    rule_template: engine.ruleTemplate,
    rule_config: engine.ruleConfig,
    output_action_type: engine.outputActionType,
    output_entity_type: engine.outputEntityType,
    risk_level: engine.riskLevel,
    cost_level: engine.costLevel,
    priority_score: engine.priorityScore,
    run_frequency: engine.runFrequency,
    enabled: engine.enabled,
    shadow_mode: engine.shadowMode,
    requires_approval: engine.requiresApproval,
    owner_module: engine.ownerModule,
    version: engine.version,
    updated_at: updatedAt
  };
}

async function getExistingSeedKeys(engineKeys: string[]): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("engine_registry")
    .select("engine_key")
    .in("engine_key", engineKeys);

  if (error) {
    logEngineRegistryError("Could not load existing engine registry seed keys.", error);
    throw new Error("Could not check existing engine registry rows in Supabase.");
  }

  return new Set(((data ?? []) as Array<{ engine_key: string }>).map((row) => row.engine_key));
}

export async function listEngineRegistryRows(filters: EngineRegistryListFilters): Promise<SafeEngineRegistryRow[]> {
  let query = supabase
    .from("engine_registry")
    .select("*")
    .order("priority_score", { ascending: false })
    .order("engine_key", { ascending: true })
    .limit(filters.limit);

  if (filters.category) query = query.eq("category", filters.category);
  if (filters.subcategory) query = query.eq("subcategory", filters.subcategory);
  if (filters.enabled !== undefined) query = query.eq("enabled", filters.enabled);

  const { data, error } = await query;

  if (error) {
    logEngineRegistryError("Could not list engine registry rows.", error);
    throw new Error("Could not load engine registry from Supabase.");
  }

  return ((data ?? []) as EngineRegistryRow[]).map(toSafeEngineRegistryRow);
}

export async function getEngineRegistryRow(engineKeyInput: string): Promise<SafeEngineRegistryRow | null> {
  const engineKey = cleanText(engineKeyInput);
  if (!engineKey) return null;

  const { data, error } = await supabase
    .from("engine_registry")
    .select("*")
    .eq("engine_key", engineKey)
    .maybeSingle<EngineRegistryRow>();

  if (error) {
    logEngineRegistryError("Could not load engine registry row.", error);
    throw new Error("Could not load engine registry row from Supabase.");
  }

  return data ? toSafeEngineRegistryRow(data) : null;
}

export async function getEngineRegistrySummary(): Promise<EngineRegistrySummary> {
  const { data, error } = await supabase
    .from("engine_registry")
    .select("*")
    .order("priority_score", { ascending: false });

  if (error) {
    logEngineRegistryError("Could not summarize engine registry.", error);
    throw new Error("Could not summarize engine registry from Supabase.");
  }

  const rows = ((data ?? []) as EngineRegistryRow[]).map(toSafeEngineRegistryRow);
  const enabledCount = rows.filter((row) => row.enabled).length;

  return {
    ok: true,
    totalEngines: rows.length,
    enabledCount,
    disabledCount: rows.length - enabledCount,
    shadowModeCount: rows.filter((row) => row.shadowMode).length,
    requiresApprovalCount: rows.filter((row) => row.requiresApproval).length,
    categoryCounts: countBy(rows, (row) => row.category),
    riskCounts: countBy(rows, (row) => row.riskLevel),
    costLevelCounts: countBy(rows, (row) => row.costLevel),
    highRiskCount: rows.filter((row) => row.riskLevel === "HIGH").length,
    lastRunFailureCount: rows.filter((row) => row.lastRunStatus === "FAILED").length
  };
}

export async function toggleEngineRegistryRow(input: {
  engineKey: string;
  enabled: boolean;
}): Promise<SafeEngineRegistryRow | null> {
  const engineKey = cleanText(input.engineKey);
  if (!engineKey) return null;

  const { data, error } = await supabase
    .from("engine_registry")
    .update({
      enabled: input.enabled,
      updated_at: new Date().toISOString()
    })
    .eq("engine_key", engineKey)
    .select("*")
    .maybeSingle<EngineRegistryRow>();

  if (error) {
    logEngineRegistryError("Could not toggle engine registry row.", error);
    throw new Error("Could not update engine registry row in Supabase.");
  }

  return data ? toSafeEngineRegistryRow(data) : null;
}

export async function createEngineRunPreview(input: {
  engineKey: string;
  sellerId: string;
  actor: string;
}): Promise<{ engine: SafeEngineRegistryRow; runLog: SafeEngineRunLogRow; message: string }> {
  const engine = await getEngineRegistryRow(input.engineKey);

  if (!engine) {
    throw new Error("ENGINE_NOT_FOUND");
  }

  const now = new Date().toISOString();
  const sellerId = cleanText(input.sellerId) ?? "default";
  const actor = cleanText(input.actor) ?? "founder";
  const message = `Preview only: ${engine.engineName} would evaluate ${engine.category} signals in shadow mode and prepare ${engine.outputActionType} for approval review. No external actions were executed.`;

  const { data, error } = await supabase
    .from("engine_run_logs")
    .insert({
      engine_key: engine.engineKey,
      seller_id: sellerId,
      run_status: "PREVIEW_ONLY",
      run_type: "MANUAL",
      input_snapshot: {
        engineKey: engine.engineKey,
        sellerId,
        actor,
        previewOnly: true
      },
      output_snapshot: {
        message,
        outputActionType: engine.outputActionType,
        outputEntityType: engine.outputEntityType,
        actionsCreatedCount: 0
      },
      actions_created_count: 0,
      finished_at: now,
      metadata: {
        actor,
        shadowMode: true,
        requiresApproval: true,
        externalExecution: false,
        amazonCall: false,
        adsCall: false,
        storeCall: false,
        listingCall: false,
        imageCall: false,
        aPlusCall: false,
        socialCall: false,
        aiCall: false,
        actionLedgerWrite: false
      }
    })
    .select("*")
    .single<EngineRunLogRow>();

  if (error || !data) {
    if (error) logEngineRegistryError("Could not create engine run preview log.", error);
    throw new Error("Could not create engine run preview log in Supabase.");
  }

  return {
    engine,
    runLog: toSafeEngineRunLogRow(data),
    message
  };
}

export async function seedEngineRegistry300(): Promise<EngineSeedResult> {
  const engines = getEngineSeedDefinitions();
  const engineKeys = engines.map((engine) => engine.engineKey);
  const existingKeys = await getExistingSeedKeys(engineKeys);
  const updatedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("engine_registry")
    .upsert(engines.map((engine) => toUpsertRow(engine, updatedAt)), { onConflict: "engine_key" })
    .select("engine_key");

  if (error) {
    logEngineRegistryError("Could not seed engine registry rows.", error);
    throw new Error("Could not seed engine registry rows in Supabase.");
  }

  const totalSeeded = (data ?? []).length;
  return {
    createdCount: engines.filter((engine) => !existingKeys.has(engine.engineKey)).length,
    updatedCount: engines.filter((engine) => existingKeys.has(engine.engineKey)).length,
    totalSeeded,
    categoryCounts: getEngineSeedCategoryCounts(engines)
  };
}
