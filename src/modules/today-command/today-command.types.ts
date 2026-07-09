export type TodayCommandSystemStatus = {
  actionLedgerReady: boolean;
  approvalCenterReady: boolean;
  engineRegistryReady: boolean;
  engineRouterReady: boolean;
  dailyOrchestratorReady: boolean;
  productPassportReady: boolean;
  productEconomicsReady: boolean;
  learningLoopReady: boolean;
  executionGatewayReady: boolean;
};

export type TodayCommandCounts = {
  pendingApprovals: number;
  approvedActions: number;
  completedActions: number;
  rejectedActions: number;
  totalEngines: number;
  enabledEngines: number;
  last24hEngineRuns: number;
  last24hActionsCreated: number;
  totalLearningEvents: number;
  enginesTracked: number;
  executionAttempts: number;
  shadowExecutions: number;
  listingDrafts: number;
  creativeRecommendations: number;
};

export type TodayCommandSummary = {
  ok: true;
  sellerId: string;
  mode: "SHADOW";
  systemStatus: TodayCommandSystemStatus;
  counts: TodayCommandCounts;
  topRisks: unknown[];
  todayPriorities: unknown[];
  nextBestActions: unknown[];
  safety: {
    shadowMode: true;
    externalExecution: false;
    liveExecutionEnabled: false;
  };
  warnings: string[];
};
