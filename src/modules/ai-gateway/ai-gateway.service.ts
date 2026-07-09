import { supabase } from "../../db/supabase";
import {
  AiBlockedInput,
  AiCostLedgerRow,
  AiEstimateInput,
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
    aiCallsEnabled: false,
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
  const { data, error } = await supabase
    .from("ai_gateway_settings")
    .upsert({
      seller_id: sellerId,
      ai_calls_enabled: false,
      daily_budget: 0,
      monthly_budget: 0,
      allowed_modules: [],
      blocked_modules: [],
      updated_at: new Date().toISOString()
    }, { onConflict: "seller_id" })
    .select("*")
    .single<AiGatewaySettingsRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not initialize AI Gateway settings.");
  return toSafeSettings(data);
}

export async function getAiGatewayStatus(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  aiCallsEnabled: false;
  dailyBudget: number;
  monthlyBudget: number;
  settings: SafeAiGatewaySettings;
  message: "AI calls are disabled in V1 foundation.";
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const settings = await ensureAiGatewaySettings(sellerId);
  return {
    ok: true,
    sellerId,
    aiCallsEnabled: false,
    dailyBudget: 0,
    monthlyBudget: 0,
    settings,
    message: "AI calls are disabled in V1 foundation."
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
  return toSafeLedger(data);
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
  aiCallsEnabled: false;
  requestsToday: number;
  requestsMonth: number;
  estimatedCostToday: number;
  estimatedCostMonth: number;
  actualCostToday: number;
  actualCostMonth: number;
  latestEntries: SafeAiCostLedgerEntry[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
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
    aiCallsEnabled: false,
    requestsToday: todayRows.length,
    requestsMonth: rows.length,
    estimatedCostToday: sumEstimated(todayRows),
    estimatedCostMonth: sumEstimated(rows),
    actualCostToday: sumActual(todayRows),
    actualCostMonth: sumActual(rows),
    latestEntries: rows.slice(0, 10)
  };
}
