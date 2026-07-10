export type MaintenanceRunRow = {
  id: string;
  seller_id: string;
  run_type: string;
  run_status: string;
  started_at: string;
  finished_at: string | null;
  safety_initialized: boolean;
  alert_rules_seeded: boolean;
  alerts_generated: number;
  data_sources_checked: number;
  learning_rebuilt: boolean;
  health_status: string | null;
  warnings: unknown[] | null;
  results: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
};

export type SafeMaintenanceRun = {
  id: string;
  sellerId: string;
  runType: string;
  runStatus: string;
  startedAt: string;
  finishedAt: string | null;
  safetyInitialized: boolean;
  alertRulesSeeded: boolean;
  alertsGenerated: number;
  dataSourcesChecked: number;
  learningRebuilt: boolean;
  healthStatus: string | null;
  warnings: unknown[];
  results: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
};
