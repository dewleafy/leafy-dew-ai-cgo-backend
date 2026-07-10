import { ExecutionAdapterAction, ExecutionPlan } from "./execution-adapters.types";

const SAFE_EXECUTION_FLAGS = {
  shadowMode: true,
  externalExecution: false,
  liveExecutionEnabled: false,
  amazonUpdate: false,
  adsUpdate: false,
  listingUpdate: false,
  imageUpload: false,
  aPlusUpload: false,
  aiCall: false
} as const;

function basePlan(action: ExecutionAdapterAction, planKind: ExecutionPlan["planKind"]): ExecutionPlan {
  return {
    planKind,
    actionId: action.id,
    actionType: action.actionType,
    entityType: action.entityType,
    entityId: action.entityId,
    sku: action.sku,
    asin: action.asin,
    steps: [],
    plannedChange: {
      actionId: action.id,
      actionType: action.actionType,
      title: action.title,
      summary: action.summary,
      recommendedAction: action.recommendedAction,
      payload: action.payload,
      guardrails: action.guardrails,
      shadowOnly: true,
      externalExecution: false
    },
    safety: SAFE_EXECUTION_FLAGS,
    validation: {
      valid: true,
      warnings: [],
      blockers: []
    }
  };
}

export function buildPpcExecutionPlan(action: ExecutionAdapterAction): ExecutionPlan {
  const plan = basePlan(action, "PPC");
  plan.steps = [
    { key: "review_ads_payload", label: "Review Ads change payload", externalExecution: false, blocked: false },
    { key: "block_ads_api", label: "Block Amazon Ads API mutation", externalExecution: false, blocked: true }
  ];
  plan.plannedChange = {
    ...plan.plannedChange,
    previewKind: "ADS_REVIEW",
    adsUpdate: false,
    proposedPayload: action.payload
  };
  return validateExecutionPlan(plan);
}

export function buildListingExecutionPlan(action: ExecutionAdapterAction): ExecutionPlan {
  const plan = basePlan(action, "LISTING");
  plan.steps = [
    { key: "review_listing_payload", label: "Review listing/content payload", externalExecution: false, blocked: false },
    { key: "block_listing_update", label: "Block SP-API listing, image, and A+ mutations", externalExecution: false, blocked: true }
  ];
  plan.plannedChange = {
    ...plan.plannedChange,
    previewKind: "CONTENT_REVIEW",
    listingUpdate: false,
    imageUpload: false,
    aPlusUpload: false,
    proposedPayload: action.payload
  };
  return validateExecutionPlan(plan);
}

export function buildPricingExecutionPlan(action: ExecutionAdapterAction): ExecutionPlan {
  const plan = basePlan(action, "PRICING");
  plan.steps = [
    { key: "review_pricing_payload", label: "Review pricing change payload", externalExecution: false, blocked: false },
    { key: "block_pricing_update", label: "Block marketplace pricing mutation", externalExecution: false, blocked: true }
  ];
  plan.plannedChange = {
    ...plan.plannedChange,
    previewKind: "PRICING_REVIEW",
    pricingUpdate: false,
    proposedPayload: action.payload
  };
  return validateExecutionPlan(plan);
}

export function validateExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  const blockers = [...plan.validation.blockers];
  const warnings = [...plan.validation.warnings];

  if (plan.safety.externalExecution !== false || plan.safety.liveExecutionEnabled !== false) {
    blockers.push("Execution plan attempted to enable external or live execution.");
  }

  if (!plan.actionId || !plan.actionType) {
    warnings.push("Execution plan is missing action identity metadata.");
  }

  return {
    ...plan,
    validation: {
      valid: blockers.length === 0,
      warnings: [...new Set(warnings)],
      blockers: [...new Set(blockers)]
    }
  };
}

export function blockLiveExecution(plan: ExecutionPlan, reason: string): ExecutionPlan {
  return validateExecutionPlan({
    ...plan,
    steps: [
      ...plan.steps,
      { key: "live_execution_blocked", label: reason, externalExecution: false, blocked: true }
    ],
    validation: {
      valid: false,
      warnings: plan.validation.warnings,
      blockers: [...plan.validation.blockers, reason]
    }
  });
}
