export type NotificationOutboxRow = {
  id: string;
  seller_id: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  message: string;
  status: string;
  source_module: string | null;
  source_id: string | null;
  severity: string;
  send_attempts: number;
  last_error: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  sent_at: string | null;
};

export type NotificationSettingsRow = {
  id: string;
  seller_id: string;
  external_notifications_enabled: boolean;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  slack_enabled: boolean;
  default_email: string | null;
  default_phone: string | null;
  default_slack_webhook: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeNotificationOutboxMessage = {
  id: string;
  sellerId: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  message: string;
  status: string;
  sourceModule: string | null;
  sourceId: string | null;
  severity: string;
  sendAttempts: number;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  sentAt: string | null;
};

export type SafeNotificationSettings = {
  id: string;
  sellerId: string;
  externalNotificationsEnabled: boolean;
  emailEnabled: boolean;
  whatsappEnabled: boolean;
  slackEnabled: boolean;
  defaultEmail: string | null;
  defaultPhone: string | null;
  defaultSlackWebhook: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
