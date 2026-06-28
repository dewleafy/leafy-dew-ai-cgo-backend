export type ActivityLogStatus = "INFO" | "SUCCESS" | "WARNING" | "ERROR";

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

export type ActivityLogRow = {
  id: string;
  seller_id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  action: string;
  status: ActivityLogStatus;
  message: string | null;
  metadata: Record<string, unknown> | null;
  user_note: string | null;
  created_at: string;
};

export type SafeActivityLogRow = {
  id: string;
  sellerId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  action: string;
  status: ActivityLogStatus;
  message: string | null;
  metadata: Record<string, unknown>;
  userNote: string | null;
  createdAt: string;
};
