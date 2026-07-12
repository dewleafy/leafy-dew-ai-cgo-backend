import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { AdapterExecutionResult, AdapterStatus, LiveExecutionPlan } from "./live-execution.types";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function listingField(actionType: string): string {
  if (actionType === "LISTING_TITLE_DRAFT_REVIEW") return "title";
  if (actionType === "LISTING_BULLETS_DRAFT_REVIEW") return "bullets";
  if (actionType === "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW") return "generic_keywords";
  if (actionType === "LISTING_DESCRIPTION_DRAFT_REVIEW") return "description";
  return "unsupported";
}

function extractProposedValue(payload: Record<string, unknown>, field: string): unknown {
  return payload.proposedValue ?? payload.proposed_value ?? payload[field] ?? payload.draftValue ?? payload.draft_value ?? null;
}

export function getListingLiveAdapterStatus(): AdapterStatus {
  return {
    configured: false,
    reason: "LIVE_LISTING_CLIENT_NOT_CONFIGURED"
  };
}

export function buildListingPlan(action: SafeActionLedgerRow): LiveExecutionPlan {
  const payload = toJsonObject(action.payload);
  const field = listingField(action.actionType);
  const proposedValue = extractProposedValue(payload, field);
  const adapter = getListingLiveAdapterStatus();
  const missingSkuOrAsin = !cleanText(action.sku) && !cleanText(action.asin);
  const missingProposedValue = proposedValue === null || proposedValue === undefined || proposedValue === "";

  return {
    domain: "LISTING",
    planType: `UPDATE_${field.toUpperCase()}`,
    actionId: action.id,
    actionType: action.actionType,
    sellerId: action.sellerId,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    externalExecution: false,
    mutationClientConfigured: adapter.configured,
    supported: field !== "unsupported" && !missingSkuOrAsin && !missingProposedValue,
    blockedReason: field === "unsupported"
      ? "LISTING_FIELD_NOT_SUPPORTED"
      : missingSkuOrAsin
        ? "LISTING_IDENTIFIER_REQUIRED"
        : missingProposedValue
          ? "LISTING_PROPOSED_VALUE_REQUIRED"
          : null,
    steps: [
      { key: "validate_safe_field", label: `Validate safe listing field ${field}`, externalExecution: false },
      { key: "capture_before_snapshot", label: "Capture before snapshot", externalExecution: false },
      { key: "require_sp_api_listing_adapter", label: "Require configured SP-API listing mutation client", externalExecution: false }
    ],
    payload: {
      sku: cleanText(action.sku),
      asin: cleanText(action.asin),
      field,
      proposedValue,
      beforeValue: payload.beforeValue ?? payload.before_value ?? payload.currentValue ?? payload.current_value ?? null,
      originalPayload: payload
    }
  };
}

export function dryRunListingPlan(plan: LiveExecutionPlan): AdapterExecutionResult {
  return {
    ok: plan.supported,
    configured: plan.mutationClientConfigured,
    blockedReason: plan.blockedReason,
    externalResponse: {
      dryRun: true,
      domain: "LISTING",
      planType: plan.planType,
      externalMutationCalled: false
    }
  };
}

export async function executeListingPlan(plan: LiveExecutionPlan): Promise<AdapterExecutionResult> {
  const adapter = getListingLiveAdapterStatus();
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
    blockedReason: "LIVE_LISTING_CLIENT_NOT_CONFIGURED",
    externalResponse: null
  };
}
