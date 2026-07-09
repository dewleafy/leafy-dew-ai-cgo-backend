export type ProductionHealthStatus = "PASS" | "WARN" | "FAIL";

export type ProductionHealthModule = {
  key: string;
  name: string;
  status: ProductionHealthStatus;
  message: string;
  critical: boolean;
  counts: Record<string, number>;
  lastCheckedAt: string;
};

export type ProductionHealthSummary = {
  ok: boolean;
  sellerId: string;
  mode: "SHADOW";
  overallStatus: ProductionHealthStatus;
  modules: ProductionHealthModule[];
  blockers: string[];
  warnings: string[];
  nextChecks: string[];
  safety: {
    shadowMode: true;
    externalExecution: false;
    liveExecutionEnabled: false;
    aiCallsEnabled: false;
  };
};
