import { supabase } from "../../db/supabase";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { AiRecommendationRow, SafeAiRecommendationRow } from "./recommendations.types";

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
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

function toSafeRecommendation(row: AiRecommendationRow): SafeAiRecommendationRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    source: row.source,
    recommendationType: row.recommendation_type,
    recommendedAction: row.recommended_action,
    entityType: row.entity_type,
    entityValue: row.entity_value,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    sku: row.sku,
    asin: row.asin,
    priorityScore: toNumber(row.priority_score),
    priorityLabel: row.priority_label ?? "LOW",
    confidenceScore: toNumber(row.confidence_score),
    confidenceLabel: row.confidence_label ?? "LOW",
    approvalTier: row.approval_tier ?? "TIER_1",
    requiresApproval: row.requires_approval ?? true,
    riskLevel: row.risk_level ?? "LOW",
    expectedProfitImpact: row.expected_profit_impact == null ? null : toNumber(row.expected_profit_impact),
    reason: row.reason,
    evidence: row.evidence ?? {},
    profitEvidence: row.profit_evidence ?? {},
    status: row.status ?? "NEW",
    userNote: row.user_note,
    ruleVersion: row.rule_version ?? "profit_ppc_v1",
    strategyVersion: row.strategy_version ?? "ai_cgo_v2_2_shadow_mode",
    dataStartDate: row.data_start_date,
    dataEndDate: row.data_end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listAiRecommendations(input: {
  sellerId: string;
  status?: string;
  limit: number;
}): Promise<SafeAiRecommendationRow[]> {
  let query = supabase
    .from("ai_recommendations")
    .select("*")
    .eq("seller_id", input.sellerId)
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (input.status) {
    query = query.eq("status", input.status);
  }

  const { data, error } = await query;

  if (error) {
    logger.warn("Could not list AI recommendations.", {
      message: sanitizeErrorMessage(error.message),
      code: sanitizeErrorMessage(error.code)
    });
    throw new Error("Could not load recommendations from Supabase.");
  }

  return ((data ?? []) as AiRecommendationRow[]).map(toSafeRecommendation);
}
