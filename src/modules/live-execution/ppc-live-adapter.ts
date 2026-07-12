import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { AdapterExecutionResult, AdapterStatus, LiveExecutionPlan } from "./live-execution.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function ppcPlanType(actionType: string): string {
  if (actionType === "ADD_EXACT_KEYWORD_AFTER_APPROVAL") return "ADD_EXACT_KEYWORD";
  if (actionType === "ADD_PRODUCT_TARGET_AFTER_APPROVAL") return "ADD_PRODUCT_TARGET";
  if (actionType === "PAUSE_WASTEFUL_TARGET_AFTER_APPROVAL") return "PAUSE_TARGET";
  if (actionType === "REDUCE_BID_AFTER_APPROVAL") return "REDUCE_BID";
  if (actionType === "INCREASE_BID_AFTER_APPROVAL") return "INCREASE_BID";
  if (actionType === "NEGATE_SEARCH_TERM_AFTER_APPROVAL") return "ADD_NEGATIVE_KEYWORD";
  if (actionType === "PPC_BUDGET_GUARDRAIL_REVIEW") return "BUDGET_GUARDRAIL_REVIEW";
  return "PPC_REVIEW_ONLY";
}

export function getPpcLiveAdapterStatus(): AdapterStatus {
  return {
    configured: false,
    reason: "LIVE_ADS_CLIENT_NOT_CONFIGURED"
  };
}

export function buildPpcPlan(action: SafeActionLedgerRow): LiveExecutionPlan {
  const payload: Record<string, unknown> = {
    ...toJsonObject(action.payload),
    evidence: toJsonObject(action.evidence),
    guardrails: toJsonObject(action.guardrails)
  };
  const adapter = getPpcLiveAdapterStatus();
  const planType = ppcPlanType(action.actionType);

  return {
    domain: "PPC",
    planType,
    actionId: action.id,
    actionType: action.actionType,
    sellerId: action.sellerId,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    externalExecution: false,
    mutationClientConfigured: adapter.configured,
    supported: true,
    blockedReason: null,
    steps: [
      { key: "validate_approval", label: "Validate founder-approved action", externalExecution: false },
      { key: "build_ads_mutation", label: `Build ${planType} mutation payload`, externalExecution: false },
      { key: "require_live_adapter", label: "Require configured Amazon Ads mutation client", externalExecution: false }
    ],
    payload: {
      campaignId: payload.campaignId ?? payload.campaign_id ?? null,
      adGroupId: payload.adGroupId ?? payload.ad_group_id ?? null,
      keywordText: cleanText(payload.keywordText ?? payload.keyword ?? action.entityId),
      asin: cleanText(payload.asin ?? action.asin),
      bid: payload.bid ?? payload.newBid ?? payload.proposedBid ?? null,
      matchType: cleanText(payload.matchType) ?? "EXACT",
      originalPayload: payload
    }
  };
}

export function dryRunPpcPlan(plan: LiveExecutionPlan): AdapterExecutionResult {
  return {
    ok: plan.supported,
    configured: plan.mutationClientConfigured,
    blockedReason: plan.blockedReason,
    externalResponse: {
      dryRun: true,
      domain: "PPC",
      planType: plan.planType,
      externalMutationCalled: false
    }
  };
}

export async function executePpcPlan(plan: LiveExecutionPlan): Promise<AdapterExecutionResult> {
  if (plan.planType === "BUDGET_GUARDRAIL_REVIEW") {
    return {
      ok: false,
      configured: false,
      blockedReason: "PPC_BUDGET_MUTATION_NOT_SUPPORTED_IN_V1",
      externalResponse: null
    };
  }

  const adapter = getPpcLiveAdapterStatus();
  if (!adapter.configured) {
    return {
      ok: false,
      configured: false,
      blockedReason: adapter.reason,
      externalResponse: null
    };
  }

  return {
    ok: false,
    configured: false,
    blockedReason: "LIVE_ADS_CLIENT_NOT_CONFIGURED",
    externalResponse: null
  };
}
