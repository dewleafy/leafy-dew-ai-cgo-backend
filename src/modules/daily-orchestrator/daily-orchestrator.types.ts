export type DailyOrchestratorRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export type DailyOrchestratorRunType = "MANUAL" | "CRON" | string;

export type DailyOrchestratorMode = "SHADOW";

export type DailyOrchestratorSafetyMetadata = {
  shadowMode: true;
  externalExecution: false;
  amazonUpdate: false;
  adsUpdate: false;
  listingUpdate: false;
  socialPost: false;
  aiCall: false;
};

export type DailyOrchestratorDataReadiness = {
  productPassportAvailable: boolean;
  productEconomicsAvailable: boolean;
  engineRegistryReady: boolean;
  engineRouterReady: boolean;
  approvalCenterReady: boolean;
};

export type DailyOrchestratorCounts = {
  totalEngines: number;
  enabledEngines: number;
  pendingApprovals: number;
  last24hEngineRuns: number;
  last24hActionsCreated: number;
};

export type DailyOrchestratorRunInput = {
  sellerId: string;
  actor: string;
  limit: number;
  categories?: string[];
  runType: DailyOrchestratorRunType;
};

export type DailyOrchestratorStatusResponse = {
  ok: true;
  sellerId: string;
  mode: DailyOrchestratorMode;
  dataReadiness: DailyOrchestratorDataReadiness;
  counts: DailyOrchestratorCounts;
  warnings: string[];
};

export type DailyOrchestratorRunResponse = {
  ok: true;
  sellerId: string;
  runId: string;
  mode: DailyOrchestratorMode;
  runStatus: "COMPLETED";
  enginesPlanned: number;
  enginesRun: number;
  actionsCreated: number;
  skippedCount: number;
  failedCount: number;
  approvalPendingBefore: number;
  approvalPendingAfter: number;
  warnings: string[];
  recommendations: string[];
  metadata: DailyOrchestratorSafetyMetadata;
  message: string;
};

export type DailyOrchestratorRunRow = {
  id: string;
  seller_id: string;
  run_type: string;
  run_status: DailyOrchestratorRunStatus | string;
  started_at: string | null;
  finished_at: string | null;
  engines_planned: number;
  engines_run: number;
  actions_created: number;
  skipped_count: number;
  failed_count: number;
  approval_pending_before: number | null;
  approval_pending_after: number | null;
  data_readiness: Record<string, unknown> | null;
  engine_summary: Record<string, unknown> | null;
  action_summary: Record<string, unknown> | null;
  warnings: unknown[] | null;
  recommendations: unknown[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

export type SafeDailyOrchestratorRun = {
  id: string;
  sellerId: string;
  runType: string;
  runStatus: string;
  startedAt: string | null;
  finishedAt: string | null;
  enginesPlanned: number;
  enginesRun: number;
  actionsCreated: number;
  skippedCount: number;
  failedCount: number;
  approvalPendingBefore: number | null;
  approvalPendingAfter: number | null;
  dataReadiness: Record<string, unknown>;
  engineSummary: Record<string, unknown>;
  actionSummary: Record<string, unknown>;
  warnings: unknown[];
  recommendations: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string | null;
};
