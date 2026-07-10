export type ActivityLogSeverity = "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "CRITICAL";
export type ActivityLogStatus = ActivityLogSeverity;

export type ActivityLogEventInput = {
  sellerId?: string | null;
  eventType: string;
  eventCategory?: string | null;
  severity?: ActivityLogSeverity;
  actor?: string | null;
  title: string;
  message?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  sku?: string | null;
  asin?: string | null;
  actionId?: string | null;
  sourceModule?: string | null;
  metadata?: Record<string, unknown>;
};

export type ActivityLogInput = {
  sellerId: string;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  action: string;
  status?: ActivityLogStatus;
  message?: string | null;
  metadata?: Record<string, unknown>;
  userNote?: string | null;
};

export type ActivityLogEventRow = {
  id: string;
  seller_id: string;
  event_type: string;
  event_category: string;
  severity: ActivityLogSeverity;
  actor: string;
  title: string;
  message: string | null;
  entity_type: string | null;
  entity_id: string | null;
  sku: string | null;
  asin: string | null;
  action_id: string | null;
  source_module: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type SafeActivityLogEvent = {
  id: string;
  sellerId: string;
  eventType: string;
  eventCategory: string;
  severity: ActivityLogSeverity;
  actor: string;
  title: string;
  message: string | null;
  entityType: string | null;
  entityId: string | null;
  sku: string | null;
  asin: string | null;
  actionId: string | null;
  sourceModule: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SafeActivityLogRow = SafeActivityLogEvent & {
  entityLabel?: string | null;
  action?: string;
  status?: ActivityLogStatus;
  userNote?: string | null;
};

export type ActivityLogSummary = {
  ok: true;
  sellerId: string;
  totalEvents: number;
  infoCount: number;
  warningCount: number;
  errorCount: number;
  criticalCount: number;
  todayEvents: number;
  latestEvents: SafeActivityLogEvent[];
};
