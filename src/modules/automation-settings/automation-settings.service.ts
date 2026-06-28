import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  AutomationMode,
  AutomationSettingsInput,
  AutomationSettingsResult,
  AutomationSettingsRow,
  SafeAutomationSettings
} from "./automation-settings.types";

export const AUTOMATION_MODES: AutomationMode[] = ["SHADOW", "APPROVAL", "AUTO_LATER"];

const AUTO_FLAG_KEYS: Array<keyof AutomationSettingsInput> = [
  "allowAutoNegative",
  "allowAutoBidChange",
  "allowAutoBudgetChange",
  "allowAutoKeywordAdd",
  "allowAutoProductTargetAdd",
  "allowAutoListingChange",
  "allowAutoPriceChange"
];

const AUTO_FLAG_WARNING = "V1 keeps risky Amazon execution disabled. Auto flags were saved as false.";

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

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

function logAutomationSettingsError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function hasRequestedTrueAutoFlag(input: AutomationSettingsInput): boolean {
  return AUTO_FLAG_KEYS.some((key) => input[key] === true);
}

function forceV1SafeAutoFlags(row: Record<string, unknown>): void {
  row.allow_auto_negative = false;
  row.allow_auto_bid_change = false;
  row.allow_auto_budget_change = false;
  row.allow_auto_keyword_add = false;
  row.allow_auto_product_target_add = false;
  row.allow_auto_listing_change = false;
  row.allow_auto_price_change = false;
}

function defaultSettingsRow(sellerId: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    seller_id: sellerId,
    mode: "SHADOW",
    max_daily_recommendations: 10,
    target_acos_default: 35,
    min_profit_low_price: 60,
    min_profit_mid_price: 110,
    approval_required_for_tier_2: true,
    approval_required_for_tier_3: true,
    shadow_mode_days: 60,
    notes: null,
    updated_at: new Date().toISOString()
  };

  forceV1SafeAutoFlags(row);
  return row;
}

function toUpdateRow(input: AutomationSettingsInput): Record<string, unknown> {
  const row: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (input.mode !== undefined) row.mode = input.mode;
  if (input.maxDailyRecommendations !== undefined) row.max_daily_recommendations = input.maxDailyRecommendations;
  if (input.targetAcosDefault !== undefined) row.target_acos_default = input.targetAcosDefault;
  if (input.minProfitLowPrice !== undefined) row.min_profit_low_price = input.minProfitLowPrice;
  if (input.minProfitMidPrice !== undefined) row.min_profit_mid_price = input.minProfitMidPrice;
  if (input.approvalRequiredForTier2 !== undefined) row.approval_required_for_tier_2 = input.approvalRequiredForTier2;
  if (input.approvalRequiredForTier3 !== undefined) row.approval_required_for_tier_3 = input.approvalRequiredForTier3;
  if (input.shadowModeDays !== undefined) row.shadow_mode_days = input.shadowModeDays;
  if (input.notes !== undefined) row.notes = cleanText(input.notes);

  forceV1SafeAutoFlags(row);
  return row;
}

function toSafeSettings(row: AutomationSettingsRow): SafeAutomationSettings {
  return {
    id: row.id,
    sellerId: row.seller_id,
    mode: AUTOMATION_MODES.includes(row.mode) ? row.mode : "SHADOW",
    maxDailyRecommendations: row.max_daily_recommendations,
    targetAcosDefault: toNumber(row.target_acos_default),
    minProfitLowPrice: toNumber(row.min_profit_low_price),
    minProfitMidPrice: toNumber(row.min_profit_mid_price),
    allowAutoNegative: false,
    allowAutoBidChange: false,
    allowAutoBudgetChange: false,
    allowAutoKeywordAdd: false,
    allowAutoProductTargetAdd: false,
    allowAutoListingChange: false,
    allowAutoPriceChange: false,
    approvalRequiredForTier2: row.approval_required_for_tier_2,
    approvalRequiredForTier3: row.approval_required_for_tier_3,
    shadowModeDays: row.shadow_mode_days,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function isAutomationMode(value: string): value is AutomationMode {
  return AUTOMATION_MODES.includes(value as AutomationMode);
}

export async function getOrCreateAutomationSettings(sellerIdInput: string): Promise<AutomationSettingsResult> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("automation_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<AutomationSettingsRow>();

  if (error) {
    logAutomationSettingsError("Could not load automation settings.", error);
    throw new Error("Could not load automation settings from Supabase.");
  }

  if (data) {
    return {
      settings: toSafeSettings(data),
      warnings: []
    };
  }

  return resetAutomationSettings(sellerId);
}

export async function upsertAutomationSettings(input: AutomationSettingsInput): Promise<AutomationSettingsResult> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const warnings = hasRequestedTrueAutoFlag(input) ? [AUTO_FLAG_WARNING] : [];
  const upsertRow = {
    seller_id: sellerId,
    ...toUpdateRow(input)
  };

  const { data, error } = await supabase
    .from("automation_settings")
    .upsert(upsertRow, { onConflict: "seller_id" })
    .select("*")
    .single<AutomationSettingsRow>();

  if (error || !data) {
    if (error) {
      logAutomationSettingsError("Could not upsert automation settings.", error);
    }
    throw new Error("Could not save automation settings in Supabase.");
  }

  return {
    settings: toSafeSettings(data),
    warnings
  };
}

export async function resetAutomationSettings(sellerIdInput: string): Promise<AutomationSettingsResult> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("automation_settings")
    .upsert(defaultSettingsRow(sellerId), { onConflict: "seller_id" })
    .select("*")
    .single<AutomationSettingsRow>();

  if (error || !data) {
    if (error) {
      logAutomationSettingsError("Could not reset automation settings.", error);
    }
    throw new Error("Could not reset automation settings in Supabase.");
  }

  return {
    settings: toSafeSettings(data),
    warnings: []
  };
}
