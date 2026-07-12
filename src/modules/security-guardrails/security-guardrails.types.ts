export type SecurityAuditEventRow = {
  id: string;
  seller_id: string;
  actor: string;
  event_type: string;
  route: string | null;
  action: string | null;
  allowed: boolean;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};

export type SafeSecurityAuditEvent = {
  id: string;
  sellerId: string;
  actor: string;
  eventType: string;
  route: string | null;
  action: string | null;
  allowed: boolean;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
};

export type DangerousOperation =
  | "LIVE_PPC_EXECUTION"
  | "LIVE_LISTING_EXECUTION"
  | "LIVE_ROLLBACK_EXECUTION"
  | "AI_GENERATE"
  | "NOTIFICATION_SEND"
  | "SAFETY_SETTING_UPDATE";
