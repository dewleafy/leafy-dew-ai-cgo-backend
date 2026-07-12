export type SafetyControlSettingsRow = {
  id: string;
  seller_id: string;
  global_mode: string;
  live_execution_enabled: boolean;
  ppc_live_execution_enabled: boolean;
  listing_live_execution_enabled: boolean;
  image_live_execution_enabled: boolean;
  a_plus_live_execution_enabled: boolean;
  social_live_execution_enabled: boolean;
  ai_calls_enabled: boolean;
  approval_required: boolean;
  founder_approval_required: boolean;
  max_daily_engine_runs: number;
  max_daily_ai_cost: number;
  max_daily_execution_attempts: number;
  approval_tier_rules: Record<string, unknown>;
  blocked_action_types: unknown[];
  safety_notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SafetyAuditEventRow = {
  id: string;
  seller_id: string;
  event_type: string;
  actor: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type SafeSafetyControlSettings = {
  id: string;
  sellerId: string;
  globalMode: string;
  liveExecutionEnabled: boolean;
  ppcLiveExecutionEnabled: boolean;
  listingLiveExecutionEnabled: boolean;
  imageLiveExecutionEnabled: boolean;
  aPlusLiveExecutionEnabled: boolean;
  socialLiveExecutionEnabled: boolean;
  aiCallsEnabled: boolean;
  approvalRequired: boolean;
  founderApprovalRequired: boolean;
  maxDailyEngineRuns: number;
  maxDailyAiCost: number;
  maxDailyExecutionAttempts: number;
  approvalTierRules: Record<string, unknown>;
  blockedActionTypes: unknown[];
  safetyNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SafetySnapshot = {
  shadowMode: boolean;
  liveExecutionEnabled: boolean;
  approvalRequired: boolean;
  aiCallsEnabled: boolean;
  externalExecution: boolean;
  settings: SafeSafetyControlSettings | null;
  message: string;
};

export type SafeSafetyAuditEvent = {
  id: string;
  sellerId: string;
  eventType: string;
  actor: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SafetyControlPatchInput = {
  globalMode?: string;
  liveExecutionEnabled?: boolean;
  ppcLiveExecutionEnabled?: boolean;
  listingLiveExecutionEnabled?: boolean;
  imageLiveExecutionEnabled?: boolean;
  aPlusLiveExecutionEnabled?: boolean;
  socialLiveExecutionEnabled?: boolean;
  aiCallsEnabled?: boolean;
  approvalRequired?: boolean;
  founderApprovalRequired?: boolean;
  maxDailyEngineRuns?: number;
  maxDailyAiCost?: number;
  maxDailyExecutionAttempts?: number;
  approvalTierRules?: Record<string, unknown>;
  blockedActionTypes?: unknown[];
  safetyNotes?: string | null;
  actor?: string;
  note?: string | null;
};
