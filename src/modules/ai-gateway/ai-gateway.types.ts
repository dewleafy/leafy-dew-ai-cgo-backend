export type AiCostLedgerRow = {
  id: string;
  seller_id: string;
  request_id: string | null;
  module_name: string;
  purpose: string | null;
  provider: string | null;
  model_name: string | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  actual_cost: number | null;
  status: string;
  blocked_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AiGatewaySettingsRow = {
  id: string;
  seller_id: string;
  ai_calls_enabled: boolean;
  daily_budget: number;
  monthly_budget: number;
  allowed_modules: unknown[];
  blocked_modules: unknown[];
  default_provider: string | null;
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeAiCostLedgerEntry = {
  id: string;
  sellerId: string;
  requestId: string | null;
  moduleName: string;
  purpose: string | null;
  provider: string | null;
  modelName: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  actualCost: number | null;
  status: string;
  blockedReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SafeAiGatewaySettings = {
  id: string;
  sellerId: string;
  aiCallsEnabled: false;
  dailyBudget: number;
  monthlyBudget: number;
  allowedModules: unknown[];
  blockedModules: unknown[];
  defaultProvider: string | null;
  defaultModel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiEstimateInput = {
  sellerId?: string;
  moduleName: string;
  purpose?: string | null;
  prompt?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  provider?: string | null;
  modelName?: string | null;
  metadata?: Record<string, unknown>;
};

export type AiBlockedInput = AiEstimateInput & {
  requestId?: string | null;
  blockedReason?: string | null;
};
