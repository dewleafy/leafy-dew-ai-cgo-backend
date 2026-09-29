export type SafeDaypartingSettings = {
  sellerId: string;
  enabled: boolean;
  timezone: string;
  activeStartHour: number;
  activeEndHour: number;
  scope: string;
  createdAt: string;
  updatedAt: string;
};

export type DaypartingSettingsRow = {
  id: string;
  seller_id: string;
  enabled: boolean;
  timezone: string;
  active_start_hour: number;
  active_end_hour: number;
  scope: string;
  created_at: string;
  updated_at: string;
};

export type DaypartingSettingsInput = {
  sellerId?: string;
  enabled?: boolean;
  activeStartHour?: number;
  activeEndHour?: number;
};

export type SafeDaypartingCampaignState = {
  campaignId: string;
  campaignName: string | null;
  pausedBySystem: boolean;
  lastAction: string | null;
  lastActionAt: string | null;
  lastError: string | null;
};

export type DaypartingCampaignStateRow = {
  campaign_id: string;
  campaign_name: string | null;
  paused_by_system: boolean;
  last_action: string | null;
  last_action_at: string | null;
  last_error: string | null;
};

export type SafeDaypartingLogEntry = {
  id: string;
  campaignId: string;
  campaignName: string | null;
  action: string;
  reason: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
};

export type DaypartingLogRow = {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  action: string;
  reason: string | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
};

export type DaypartingCheckResult = {
  ran: boolean;
  summary: string;
  currentlyActiveHours: boolean | null;
  pausedCount: number;
  resumedCount: number;
  failedCount: number;
  // Campaigns Amazon has already marked ENDED (endDate in the past). Amazon rejects
  // any state update to these ("Ended campaign cannot be updated without end date
  // extension") no matter what dayparting does, so these are skipped rather than
  // retried every run and counted as failures. See amazon-ads-dayparting.service.ts.
  skippedEndedCount: number;
};
