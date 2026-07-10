export type ExecutionPlanKind = "PPC" | "LISTING" | "PRICING" | "GENERIC";

export type ExecutionPlan = {
  planKind: ExecutionPlanKind;
  actionId: string;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  steps: Array<{
    key: string;
    label: string;
    externalExecution: false;
    blocked: boolean;
  }>;
  plannedChange: Record<string, unknown>;
  safety: {
    shadowMode: true;
    externalExecution: false;
    liveExecutionEnabled: false;
    amazonUpdate: false;
    adsUpdate: false;
    listingUpdate: false;
    imageUpload: false;
    aPlusUpload: false;
    aiCall: false;
  };
  validation: {
    valid: boolean;
    warnings: string[];
    blockers: string[];
  };
};

export type ExecutionAdapterAction = {
  id: string;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  title: string;
  summary: string | null;
  recommendedAction: string | null;
  payload: Record<string, unknown>;
  guardrails: Record<string, unknown>;
};
