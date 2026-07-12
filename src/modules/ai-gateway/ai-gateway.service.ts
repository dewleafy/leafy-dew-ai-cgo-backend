import { supabase } from "../../db/supabase";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { checkSecurityGuardrail } from "../security-guardrails/security-guardrails.service";
import {
  AiBlockedInput,
  AiCostLedgerRow,
  AiEstimateInput,
  AiGenerateInput,
  AiGatewaySettingsRow,
  SafeAiCostLedgerEntry,
  SafeAiGatewaySettings
} from "./ai-gateway.types";

const INPUT_COST_PER_1K = 0.0005;
const OUTPUT_COST_PER_1K = 0.0015;

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

function estimateTokensFromPrompt(prompt: string | null): number {
  if (!prompt) return 0;
  return Math.ceil(prompt.length / 4);
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return Number(((inputTokens / 1000) * INPUT_COST_PER_1K + (outputTokens / 1000) * OUTPUT_COST_PER_1K).toFixed(6));
}

function toSafeSettings(row: AiGatewaySettingsRow): SafeAiGatewaySettings {
  return {
    id: row.id,
    sellerId: row.seller_id,
    aiCallsEnabled: Boolean(row.ai_calls_enabled),
    dailyBudget: toNumber(row.daily_budget),
    monthlyBudget: toNumber(row.monthly_budget),
    allowedModules: toJsonArray(row.allowed_modules),
    blockedModules: toJsonArray(row.blocked_modules),
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeLedger(row: AiCostLedgerRow): SafeAiCostLedgerEntry {
  return {
    id: row.id,
    sellerId: row.seller_id,
    requestId: row.request_id,
    moduleName: row.module_name,
    purpose: row.purpose,
    provider: row.provider,
    modelName: row.model_name,
    inputTokens: toNumber(row.input_tokens),
    outputTokens: toNumber(row.output_tokens),
    estimatedCost: toNumber(row.estimated_cost),
    actualCost: row.actual_cost === null ? null : toNumber(row.actual_cost),
    status: row.status,
    blockedReason: row.blocked_reason,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

export async function ensureAiGatewaySettings(sellerIdInput: string): Promise<SafeAiGatewaySettings> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const existing = await supabase
    .from("ai_gateway_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<AiGatewaySettingsRow>();

  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return toSafeSettings(existing.data);

  const { data, error } = await supabase
    .from("ai_gateway_settings")
    .insert({
      seller_id: sellerId,
      ai_calls_enabled: false,
      daily_budget: 0,
      monthly_budget: 0,
      allowed_modules: [],
      blocked_modules: [],
      updated_at: new Date().toISOString()
    })
    .select("*")
    .single<AiGatewaySettingsRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not initialize AI Gateway settings.");
  return toSafeSettings(data);
}

export async function getAiGatewayStatus(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  aiCallsEnabled: boolean;
  dailyBudget: number;
  monthlyBudget: number;
  settings: SafeAiGatewaySettings;
  message: string;
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const settings = await ensureAiGatewaySettings(sellerId);
  return {
    ok: true,
    sellerId,
    aiCallsEnabled: settings.aiCallsEnabled,
    dailyBudget: settings.dailyBudget,
    monthlyBudget: settings.monthlyBudget,
    settings,
    message: settings.aiCallsEnabled
      ? "AI calls are enabled in settings but still require budget, allowed module, and provider configuration."
      : "AI calls are disabled by default."
  };
}

export function estimateAiUsage(input: AiEstimateInput): {
  ok: true;
  sellerId: string;
  moduleName: string;
  purpose: string | null;
  provider: string | null;
  modelName: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  aiCallsEnabled: false;
  externalAiCall: false;
  message: string;
} {
  const inputTokens = Math.max(Math.floor(input.inputTokens ?? estimateTokensFromPrompt(cleanText(input.prompt))), 0);
  const outputTokens = Math.max(Math.floor(input.outputTokens ?? Math.ceil(inputTokens * 0.4)), 0);
  return {
    ok: true,
    sellerId: cleanText(input.sellerId) ?? "default",
    moduleName: cleanText(input.moduleName) ?? "UNKNOWN_MODULE",
    purpose: cleanText(input.purpose),
    provider: cleanText(input.provider),
    modelName: cleanText(input.modelName),
    inputTokens,
    outputTokens,
    estimatedCost: estimateCost(inputTokens, outputTokens),
    aiCallsEnabled: false,
    externalAiCall: false,
    message: "Estimate only. AI calls are disabled in V1 foundation."
  };
}

const ALLOWED_FUTURE_MODULES = new Set([
  "LISTING_DRAFTS",
  "CREATIVE_RECOMMENDATIONS",
  "CEO_REPORT",
  "ENGINE_SUMMARY",
  "EXPERIMENT_SUMMARY"
]);

async function sumEstimatedCostSince(sellerId: string, sinceIso: string): Promise<number> {
  const { data, error } = await supabase
    .from("ai_cost_ledger")
    .select("estimated_cost")
    .eq("seller_id", sellerId)
    .gte("created_at", sinceIso);
  if (error) return 0;
  return Number(((data ?? []) as Array<{ estimated_cost: number | string }>).reduce((total, row) => total + toNumber(row.estimated_cost), 0).toFixed(6));
}

export async function recordBlockedAiAttempt(input: AiBlockedInput): Promise<SafeAiCostLedgerEntry> {
  const estimate = estimateAiUsage(input);
  const { data, error } = await supabase
    .from("ai_cost_ledger")
    .insert({
      seller_id: estimate.sellerId,
      request_id: cleanText(input.requestId),
      module_name: estimate.moduleName,
      purpose: estimate.purpose,
      provider: estimate.provider,
      model_name: estimate.modelName,
      input_tokens: estimate.inputTokens,
      output_tokens: estimate.outputTokens,
      estimated_cost: estimate.estimatedCost,
      actual_cost: null,
      status: "BLOCKED",
      blocked_reason: cleanText(input.blockedReason) ?? "AI calls are disabled in V1 foundation.",
      metadata: {
        ...(input.metadata ?? {}),
        aiCallsEnabled: false,
        externalAiCall: false,
        shadowMode: true
      }
    })
    .select("*")
    .single<AiCostLedgerRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not record blocked AI attempt.");
  const row = toSafeLedger(data);
  await safeRecordActivityLog({
    sellerId: row.sellerId,
    eventType: "AI_GATEWAY_BLOCKED_ATTEMPT_RECORDED",
    eventCategory: "AI_GATEWAY",
    severity: "WARNING",
    actor: "system",
    title: "AI call blocked",
    message: "AI call attempt was recorded as blocked. No external AI call executed.",
    sourceModule: "ai-gateway",
    metadata: {
      requestId: row.requestId,
      moduleName: row.moduleName,
      estimatedCost: row.estimatedCost,
      aiCallsEnabled: false,
      externalAiCall: false
    }
  });

  return row;
}

export async function generateAiResponse(input: AiGenerateInput): Promise<{
  ok: boolean;
  blockedReason: string | null;
  entry: SafeAiCostLedgerEntry;
  output: null;
  message: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const settings = await ensureAiGatewaySettings(sellerId);
  const estimate = estimateAiUsage({
    ...input,
    sellerId,
    outputTokens: input.outputTokens ?? input.maxOutputTokens
  });
  const moduleName = estimate.moduleName;
  const allowedModules = toJsonArray(settings.allowedModules).map(String);
  const blockedModules = toJsonArray(settings.blockedModules).map(String);
  const security = await checkSecurityGuardrail({
    sellerId,
    actor: input.actor ?? "system",
    action: "AI_GENERATE",
    route: "/api/ai-gateway/generate",
    metadata: { moduleName }
  }).catch(() => null);
  let blockedReason: string | null = null;

  if (security && !security.allowed) {
    blockedReason = security.reason ?? "SECURITY_GUARDRAIL_BLOCKED";
  } else if (!settings.aiCallsEnabled) {
    blockedReason = "AI_CALLS_DISABLED";
  } else if (!ALLOWED_FUTURE_MODULES.has(moduleName)) {
    blockedReason = "AI_MODULE_NOT_ALLOWED";
  } else if (allowedModules.length > 0 && !allowedModules.includes(moduleName)) {
    blockedReason = "AI_MODULE_NOT_ALLOWED_BY_SETTINGS";
  } else if (blockedModules.includes(moduleName)) {
    blockedReason = "AI_MODULE_BLOCKED_BY_SETTINGS";
  }

  if (!blockedReason) {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [todayCost, monthCost] = await Promise.all([
      sumEstimatedCostSince(sellerId, todayStart.toISOString()),
      sumEstimatedCostSince(sellerId, monthStart.toISOString())
    ]);
    if (settings.dailyBudget <= 0 || todayCost + estimate.estimatedCost > settings.dailyBudget) {
      blockedReason = "AI_DAILY_BUDGET_EXCEEDED";
    } else if (settings.monthlyBudget <= 0 || monthCost + estimate.estimatedCost > settings.monthlyBudget) {
      blockedReason = "AI_MONTHLY_BUDGET_EXCEEDED";
    }
  }

  if (!blockedReason && !process.env.OPENAI_API_KEY) {
    blockedReason = "AI_PROVIDER_NOT_CONFIGURED";
  }

  const entry = await recordBlockedAiAttempt({
    ...input,
    sellerId,
    blockedReason: blockedReason ?? "AI_PROVIDER_NOT_CONFIGURED",
    metadata: {
      ...(input.metadata ?? {}),
      generateEndpoint: true,
      estimatedCost: estimate.estimatedCost,
      providerConfigured: Boolean(process.env.OPENAI_API_KEY)
    }
  });

  return {
    ok: false,
    blockedReason: blockedReason ?? "AI_PROVIDER_NOT_CONFIGURED",
    entry,
    output: null,
    message: "AI generation blocked safely. No provider call executed."
  };
}

export async function listAiCostLedger(input: { sellerId: string; limit: number }): Promise<SafeAiCostLedgerEntry[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("ai_cost_ledger")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AiCostLedgerRow[]).map(toSafeLedger);
}

export async function getAiCostSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  aiCallsEnabled: boolean;
  requestsToday: number;
  requestsMonth: number;
  estimatedCostToday: number;
  estimatedCostMonth: number;
  actualCostToday: number;
  actualCostMonth: number;
  latestEntries: SafeAiCostLedgerEntry[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const settings = await ensureAiGatewaySettings(sellerId);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("ai_cost_ledger")
    .select("*")
    .eq("seller_id", sellerId)
    .gte("created_at", monthStart.toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as AiCostLedgerRow[]).map(toSafeLedger);
  const todayRows = rows.filter((row) => Date.parse(row.createdAt) >= todayStart.getTime());
  const sumEstimated = (items: SafeAiCostLedgerEntry[]) => Number(items.reduce((total, row) => total + row.estimatedCost, 0).toFixed(6));
  const sumActual = (items: SafeAiCostLedgerEntry[]) => Number(items.reduce((total, row) => total + (row.actualCost ?? 0), 0).toFixed(6));

  return {
    ok: true,
    sellerId,
    aiCallsEnabled: settings.aiCallsEnabled,
    requestsToday: todayRows.length,
    requestsMonth: rows.length,
    estimatedCostToday: sumEstimated(todayRows),
    estimatedCostMonth: sumEstimated(rows),
    actualCostToday: sumActual(todayRows),
    actualCostMonth: sumActual(rows),
    latestEntries: rows.slice(0, 10)
  };
}
