import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";
import { SafeEngineRegistryRow, SafeEngineRunLogRow } from "../engine-registry/engine-registry.types";

export type EngineRunStatus =
  | "PREVIEW_ACTION_CREATED"
  | "PREVIEW_NO_ACTION"
  | "SKIPPED_NO_DATA"
  | "SKIPPED_TEMPLATE_NOT_IMPLEMENTED"
  | "FAILED";

export type EngineRouterActionDraft = {
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  title: string;
  summary: string;
  recommendedAction: string;
  expectedProfitImpact?: number | null;
  expectedSalesImpact?: number | null;
  expectedBrandImpact?: number | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidenceLabel: "LOW" | "MEDIUM" | "HIGH";
  approvalTier: "TIER_1" | "TIER_2" | "TIER_3" | "FOUNDER_OVERRIDE";
  evidence: Record<string, unknown>;
};

export type EnginePreviewDecision = {
  status: EngineRunStatus;
  summary: string;
  actionDraft?: EngineRouterActionDraft;
  evidence?: Record<string, unknown>;
  skippedReason?: string;
};

export type EngineRunResult = {
  engine: SafeEngineRegistryRow;
  status: EngineRunStatus;
  summary: string;
  actionCreated: boolean;
  duplicateSkipped: boolean;
  action: SafeActionLedgerRow | null;
  log: SafeEngineRunLogRow;
};

export type EngineRouterRunPreviewInput = {
  sellerId: string;
  limit: number;
  categories?: string[];
  actor: string;
};

export type EngineRouterSummary = {
  ok: true;
  sellerId: string;
  totalEngines: number;
  enabledEngines: number;
  last24hRuns: number;
  last24hActionsCreated: number;
  failedRuns: number;
  previewOnlyRuns: number;
  topCategoriesRun: Record<string, number>;
};
