export type AlertSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertEventStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";

export type AlertRuleRow = {
  id: string;
  seller_id: string;
  rule_key: string;
  rule_name: string;
  category: string;
  severity: AlertSeverity;
  enabled: boolean;
  condition_config: Record<string, unknown>;
  cooldown_hours: number;
  created_at: string;
  updated_at: string;
};

export type AlertEventRow = {
  id: string;
  seller_id: string;
  rule_key: string | null;
  category: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  action_id: string | null;
  status: AlertEventStatus;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

export type SafeAlertRule = {
  id: string;
  sellerId: string;
  ruleKey: string;
  ruleName: string;
  category: string;
  severity: AlertSeverity;
  enabled: boolean;
  conditionConfig: Record<string, unknown>;
  cooldownHours: number;
  createdAt: string;
  updatedAt: string;
};

export type SafeAlertEvent = {
  id: string;
  sellerId: string;
  ruleKey: string | null;
  category: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  actionId: string | null;
  status: AlertEventStatus;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
};

export type AlertCandidate = {
  ruleKey: string;
  category: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  sku?: string | null;
  asin?: string | null;
  actionId?: string | null;
  metadata?: Record<string, unknown>;
};
