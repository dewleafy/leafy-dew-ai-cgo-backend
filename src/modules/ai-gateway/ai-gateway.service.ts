import axios from "axios";
import { env } from "../../config/env";
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

// OpenAI pricing for the configured OPENAI_MODEL (per official pricing page, confirm at
// platform.openai.com/docs/pricing if a live call ever fails with "model not found" or the
// account's actual per-token rate differs — pricing/model IDs can change):
// $0.20 / MTok input, $1.20 / MTok output => $0.0002 / 1K input, $0.0012 / 1K output.
const INPUT_COST_PER_1K = 0.0002;
const OUTPUT_COST_PER_1K = 0.0012;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

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

export async function updateAiGatewaySettings(
  sellerIdInput: string,
  patch: {
    aiCallsEnabled?: boolean;
    dailyBudget?: number;
    monthlyBudget?: number;
    allowedModules?: unknown[];
    blockedModules?: unknown[];
    defaultProvider?: string | null;
    defaultModel?: string | null;
  }
): Promise<SafeAiGatewaySettings> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  await ensureAiGatewaySettings(sellerId);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.aiCallsEnabled !== undefined) updates.ai_calls_enabled = Boolean(patch.aiCallsEnabled);
  if (patch.dailyBudget !== undefined) updates.daily_budget = Math.max(toNumber(patch.dailyBudget), 0);
  if (patch.monthlyBudget !== undefined) updates.monthly_budget = Math.max(toNumber(patch.monthlyBudget), 0);
  if (patch.allowedModules !== undefined) updates.allowed_modules = toJsonArray(patch.allowedModules);
  if (patch.blockedModules !== undefined) updates.blocked_modules = toJsonArray(patch.blockedModules);
  if (patch.defaultProvider !== undefined) updates.default_provider = cleanText(patch.defaultProvider);
  if (patch.defaultModel !== undefined) updates.default_model = cleanText(patch.defaultModel);

  const { data, error } = await supabase
    .from("ai_gateway_settings")
    .update(updates)
    .eq("seller_id", sellerId)
    .select("*")
    .single<AiGatewaySettingsRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not update AI Gateway settings.");
  const row = toSafeSettings(data);

  await safeRecordActivityLog({
    sellerId: row.sellerId,
    eventType: "AI_GATEWAY_SETTINGS_UPDATED",
    eventCategory: "AI_GATEWAY",
    severity: "INFO",
    actor: "founder",
    title: "AI Gateway settings updated",
    message: row.aiCallsEnabled
      ? "AI calls are now enabled for this seller, subject to daily/monthly budgets and allowed modules."
      : "AI calls are disabled for this seller.",
    sourceModule: "ai-gateway",
    metadata: { aiCallsEnabled: row.aiCallsEnabled, dailyBudget: row.dailyBudget, monthlyBudget: row.monthlyBudget }
  });

  return row;
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
  // Added 2026-10-05 for the Listing Optimizer's scoring rubric (PART C-1-style judgement calls,
  // text-only -- title/bullet readability, clarity, feature/benefit). Also added to this seller's
  // ai_gateway_settings.allowed_modules in Supabase directly (allowed_modules is a per-seller
  // allow-list on TOP OF this hardcoded one -- both must include a module for its calls to go
  // through).
  "LISTING_OPTIMIZER",
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

async function callOpenAiChatCompletion(input: {
  prompt: string;
  maxOutputTokens: number;
  model: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const response = await axios.post(
    OPENAI_CHAT_COMPLETIONS_URL,
    {
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
      // "max_completion_tokens" is accepted everywhere "max_tokens" is and is required on
      // reasoning-capable models, so it's used defensively here regardless of which model is configured.
      max_completion_tokens: input.maxOutputTokens
    },
    {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}`,
        "content-type": "application/json"
      },
      timeout: 60000
    }
  );

  const data = response.data as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = cleanText(data.choices?.[0]?.message?.content) ?? "";

  return {
    text,
    inputTokens: toNumber(data.usage?.prompt_tokens),
    outputTokens: toNumber(data.usage?.completion_tokens)
  };
}

async function callOpenAiVisionChatCompletion(input: {
  prompt: string;
  imageUrls: string[];
  maxOutputTokens: number;
  model: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.prompt },
    ...input.imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))
  ];

  const response = await axios.post(
    OPENAI_CHAT_COMPLETIONS_URL,
    {
      model: input.model,
      messages: [{ role: "user", content }],
      max_completion_tokens: input.maxOutputTokens
    },
    {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}`,
        "content-type": "application/json"
      },
      // Vision calls (multiple images per request) run slower than text-only rubric calls.
      timeout: 90000
    }
  );

  const data = response.data as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = cleanText(data.choices?.[0]?.message?.content) ?? "";

  return {
    text,
    inputTokens: toNumber(data.usage?.prompt_tokens),
    outputTokens: toNumber(data.usage?.completion_tokens)
  };
}

// Vision twin of generateAiResponse below: same guardrail/budget/ledger logic (security
// guardrail, AI_CALLS_DISABLED, module allow-list, daily/monthly budget, provider-configured
// check), but sends image content parts to OpenAI instead of a text-only prompt, and uses
// OPENAI_VISION_MODEL (falling back to OPENAI_MODEL) instead of the text model override chain.
// Kept as a separate function rather than branching inside generateAiResponse so the existing,
// already-live text-judging path (title/bullet rubric) can't regress from this change.
export async function generateAiVisionResponse(input: AiGenerateInput & { imageUrls: string[] }): Promise<{
  ok: boolean;
  blockedReason: string | null;
  entry: SafeAiCostLedgerEntry;
  output: string | null;
  message: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const settings = await ensureAiGatewaySettings(sellerId);
  const prompt = cleanText(input.prompt);
  const imageUrls = (input.imageUrls ?? []).filter((url) => typeof url === "string" && url.trim().length > 0);
  const maxOutputTokens = Math.min(Math.max(Math.floor(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS), 1), 4096);
  // Vision prompts cost more (each image is billed as input tokens on top of the text prompt) --
  // estimate conservatively per image until a real response tells us the actual usage.
  const estimate = estimateAiUsage({
    ...input,
    sellerId,
    inputTokens: (input.inputTokens ?? estimateTokensFromPrompt(prompt)) + imageUrls.length * 1200,
    outputTokens: input.outputTokens ?? maxOutputTokens
  });
  const moduleName = estimate.moduleName;
  const allowedModules = toJsonArray(settings.allowedModules).map(String);
  const blockedModules = toJsonArray(settings.blockedModules).map(String);
  const security = await checkSecurityGuardrail({
    sellerId,
    actor: input.actor ?? "system",
    action: "AI_GENERATE",
    route: "/api/ai-gateway/generate",
    metadata: { moduleName, vision: true }
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
  } else if (!prompt) {
    blockedReason = "AI_PROMPT_REQUIRED";
  } else if (imageUrls.length === 0) {
    blockedReason = "AI_VISION_NO_IMAGES_PROVIDED";
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

  if (!blockedReason && !env.OPENAI_API_KEY) {
    blockedReason = "AI_PROVIDER_NOT_CONFIGURED";
  }

  if (blockedReason) {
    const entry = await recordBlockedAiAttempt({
      ...input,
      sellerId,
      blockedReason,
      metadata: {
        ...(input.metadata ?? {}),
        generateEndpoint: true,
        vision: true,
        imageCount: imageUrls.length,
        estimatedCost: estimate.estimatedCost,
        providerConfigured: Boolean(env.OPENAI_API_KEY)
      }
    });

    return {
      ok: false,
      blockedReason,
      entry,
      output: null,
      message: "AI vision generation blocked safely. No provider call executed."
    };
  }

  const promptText = prompt ?? "";
  const model = cleanText(input.modelName) ?? cleanText(settings.defaultModel) ?? env.OPENAI_VISION_MODEL ?? env.OPENAI_MODEL;
  const provider = cleanText(input.provider) ?? cleanText(settings.defaultProvider) ?? "openai";

  try {
    const result = await callOpenAiVisionChatCompletion({ prompt: promptText, imageUrls, maxOutputTokens, model });
    const actualCost = estimateCost(result.inputTokens, result.outputTokens);

    const { data, error } = await supabase
      .from("ai_cost_ledger")
      .insert({
        seller_id: sellerId,
        request_id: cleanText(input.requestId),
        module_name: moduleName,
        purpose: estimate.purpose,
        provider,
        model_name: model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        estimated_cost: estimate.estimatedCost,
        actual_cost: actualCost,
        status: "COMPLETED",
        blocked_reason: null,
        metadata: {
          ...(input.metadata ?? {}),
          generateEndpoint: true,
          vision: true,
          imageCount: imageUrls.length,
          aiCallsEnabled: true,
          externalAiCall: true,
          outputPreview: result.text.slice(0, 500)
        }
      })
      .select("*")
      .single<AiCostLedgerRow>();

    if (error || !data) throw new Error(error?.message ?? "Could not record AI vision call result.");
    const entry = toSafeLedger(data);

    await safeRecordActivityLog({
      sellerId,
      eventType: "AI_GATEWAY_CALL_COMPLETED",
      eventCategory: "AI_GATEWAY",
      severity: "INFO",
      actor: "system",
      title: "AI vision call completed",
      message: "AI vision judging call completed successfully.",
      sourceModule: "ai-gateway",
      metadata: { requestId: entry.requestId, moduleName: entry.moduleName, actualCost: entry.actualCost, imageCount: imageUrls.length }
    });

    return {
      ok: true,
      blockedReason: null,
      entry,
      output: result.text || null,
      message: "AI vision generation completed."
    };
  } catch (callError) {
    const failureReason = "AI_PROVIDER_CALL_FAILED";
    const entry = await recordBlockedAiAttempt({
      ...input,
      sellerId,
      blockedReason: failureReason,
      metadata: {
        ...(input.metadata ?? {}),
        generateEndpoint: true,
        vision: true,
        imageCount: imageUrls.length,
        estimatedCost: estimate.estimatedCost,
        providerConfigured: true,
        providerError: callError instanceof Error ? callError.message : "Unknown provider error"
      }
    });

    return {
      ok: false,
      blockedReason: failureReason,
      entry,
      output: null,
      message: "AI vision generation failed when calling the provider. The attempt was recorded; no image judgement was produced."
    };
  }
}

export async function generateAiResponse(input: AiGenerateInput): Promise<{
  ok: boolean;
  blockedReason: string | null;
  entry: SafeAiCostLedgerEntry;
  output: string | null;
  message: string;
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const settings = await ensureAiGatewaySettings(sellerId);
  const prompt = cleanText(input.prompt);
  const maxOutputTokens = Math.min(Math.max(Math.floor(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS), 1), 4096);
  const estimate = estimateAiUsage({
    ...input,
    sellerId,
    outputTokens: input.outputTokens ?? maxOutputTokens
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
  } else if (!prompt) {
    blockedReason = "AI_PROMPT_REQUIRED";
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

  if (!blockedReason && !env.OPENAI_API_KEY) {
    blockedReason = "AI_PROVIDER_NOT_CONFIGURED";
  }

  if (blockedReason) {
    const entry = await recordBlockedAiAttempt({
      ...input,
      sellerId,
      blockedReason,
      metadata: {
        ...(input.metadata ?? {}),
        generateEndpoint: true,
        estimatedCost: estimate.estimatedCost,
        providerConfigured: Boolean(env.OPENAI_API_KEY)
      }
    });

    return {
      ok: false,
      blockedReason,
      entry,
      output: null,
      message: "AI generation blocked safely. No provider call executed."
    };
  }

  // Reached only when every guardrail above passed, which requires `prompt` to be non-empty.
  const promptText = prompt ?? "";
  const model = cleanText(input.modelName) ?? cleanText(settings.defaultModel) ?? env.OPENAI_MODEL;
  const provider = cleanText(input.provider) ?? cleanText(settings.defaultProvider) ?? "openai";

  try {
    const result = await callOpenAiChatCompletion({ prompt: promptText, maxOutputTokens, model });
    const actualCost = estimateCost(result.inputTokens, result.outputTokens);

    const { data, error } = await supabase
      .from("ai_cost_ledger")
      .insert({
        seller_id: sellerId,
        request_id: cleanText(input.requestId),
        module_name: moduleName,
        purpose: estimate.purpose,
        provider,
        model_name: model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        estimated_cost: estimate.estimatedCost,
        actual_cost: actualCost,
        status: "COMPLETED",
        blocked_reason: null,
        metadata: {
          ...(input.metadata ?? {}),
          generateEndpoint: true,
          aiCallsEnabled: true,
          externalAiCall: true,
          outputPreview: result.text.slice(0, 500)
        }
      })
      .select("*")
      .single<AiCostLedgerRow>();

    if (error || !data) throw new Error(error?.message ?? "Could not record AI call result.");
    const entry = toSafeLedger(data);

    await safeRecordActivityLog({
      sellerId,
      eventType: "AI_GATEWAY_CALL_COMPLETED",
      eventCategory: "AI_GATEWAY",
      severity: "INFO",
      actor: "system",
      title: "AI call completed",
      message: "AI generation call completed successfully.",
      sourceModule: "ai-gateway",
      metadata: { requestId: entry.requestId, moduleName: entry.moduleName, actualCost: entry.actualCost }
    });

    return {
      ok: true,
      blockedReason: null,
      entry,
      output: result.text || null,
      message: "AI generation completed."
    };
  } catch (callError) {
    const failureReason = "AI_PROVIDER_CALL_FAILED";
    const entry = await recordBlockedAiAttempt({
      ...input,
      sellerId,
      blockedReason: failureReason,
      metadata: {
        ...(input.metadata ?? {}),
        generateEndpoint: true,
        estimatedCost: estimate.estimatedCost,
        providerConfigured: true,
        providerError: callError instanceof Error ? callError.message : "Unknown provider error"
      }
    });

    return {
      ok: false,
      blockedReason: failureReason,
      entry,
      output: null,
      message: "AI generation failed when calling the provider. The attempt was recorded; no listing content was produced."
    };
  }
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
