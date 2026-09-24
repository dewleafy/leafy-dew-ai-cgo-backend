import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getAmazonAdsAccessToken } from "./amazon-ads-token.service";
import {
  getSponsoredProductsCampaignsWithRaw,
  logSafeAmazonAdsSupabaseError,
  updateSponsoredProductsCampaignStates
} from "./amazon-ads-client.service";
import { saveAmazonAdsCampaigns } from "./amazon-ads-campaign.service";
import { loadAmazonAdsCampaignContext } from "./amazon-ads.controller";
import {
  DaypartingCampaignStateRow,
  DaypartingCheckResult,
  DaypartingLogRow,
  DaypartingSettingsInput,
  DaypartingSettingsRow,
  SafeDaypartingCampaignState,
  SafeDaypartingLogEntry,
  SafeDaypartingSettings
} from "./amazon-ads-dayparting.types";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function toSafeSettings(row: DaypartingSettingsRow): SafeDaypartingSettings {
  return {
    sellerId: row.seller_id,
    enabled: row.enabled,
    timezone: row.timezone,
    activeStartHour: row.active_start_hour,
    activeEndHour: row.active_end_hour,
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeCampaignState(row: DaypartingCampaignStateRow): SafeDaypartingCampaignState {
  return {
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    pausedBySystem: row.paused_by_system,
    lastAction: row.last_action,
    lastActionAt: row.last_action_at,
    lastError: row.last_error
  };
}

function toSafeLogEntry(row: DaypartingLogRow): SafeDaypartingLogEntry {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    action: row.action,
    reason: row.reason,
    success: row.success,
    errorMessage: row.error_message,
    createdAt: row.created_at
  };
}

export async function getOrCreateDaypartingSettings(sellerIdInput: string): Promise<SafeDaypartingSettings> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("dayparting_settings")
    .select("*")
    .eq("seller_id", sellerId)
    .maybeSingle<DaypartingSettingsRow>();

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load dayparting settings.", error);
    throw new Error("Could not load dayparting settings from Supabase. Run dayparting.sql in Supabase first.");
  }

  if (data) {
    return toSafeSettings(data);
  }

  const { data: created, error: insertError } = await supabase
    .from("dayparting_settings")
    .upsert(
      {
        seller_id: sellerId,
        enabled: false,
        timezone: DEFAULT_TIMEZONE,
        active_start_hour: 8,
        active_end_hour: 23,
        scope: "ALL_CAMPAIGNS",
        updated_at: new Date().toISOString()
      },
      { onConflict: "seller_id" }
    )
    .select("*")
    .single<DaypartingSettingsRow>();

  if (insertError || !created) {
    if (insertError) logSafeAmazonAdsSupabaseError("Could not create default dayparting settings.", insertError);
    throw new Error("Could not create default dayparting settings in Supabase.");
  }

  return toSafeSettings(created);
}

export async function upsertDaypartingSettings(input: DaypartingSettingsInput): Promise<SafeDaypartingSettings> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  // Make sure a row exists first, so a PUT that only changes `enabled` doesn't
  // wipe out previously-saved hours.
  await getOrCreateDaypartingSettings(sellerId);

  const updateRow: Record<string, unknown> = {
    seller_id: sellerId,
    updated_at: new Date().toISOString()
  };

  if (input.enabled !== undefined) updateRow.enabled = input.enabled;
  if (input.activeStartHour !== undefined) updateRow.active_start_hour = input.activeStartHour;
  if (input.activeEndHour !== undefined) updateRow.active_end_hour = input.activeEndHour;

  const { data, error } = await supabase
    .from("dayparting_settings")
    .upsert(updateRow, { onConflict: "seller_id" })
    .select("*")
    .single<DaypartingSettingsRow>();

  if (error || !data) {
    if (error) logSafeAmazonAdsSupabaseError("Could not save dayparting settings.", error);
    throw new Error("Could not save dayparting settings in Supabase.");
  }

  return toSafeSettings(data);
}

export async function listDaypartingCampaignStates(sellerIdInput: string): Promise<SafeDaypartingCampaignState[]> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("dayparting_campaign_state")
    .select("campaign_id, campaign_name, paused_by_system, last_action, last_action_at, last_error")
    .eq("seller_id", sellerId)
    .order("last_action_at", { ascending: false });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load dayparting campaign state.", error);
    throw new Error("Could not load dayparting campaign state from Supabase.");
  }

  return ((data ?? []) as DaypartingCampaignStateRow[]).map(toSafeCampaignState);
}

export async function listDaypartingHistory(sellerIdInput: string, limit = 50): Promise<SafeDaypartingLogEntry[]> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const { data, error } = await supabase
    .from("dayparting_action_log")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load dayparting history.", error);
    throw new Error("Could not load dayparting history from Supabase.");
  }

  return ((data ?? []) as DaypartingLogRow[]).map(toSafeLogEntry);
}

function getHourInTimeZone(date: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((part) => part.type === "hour");
    const hour = hourPart ? Number(hourPart.value) : NaN;
    return Number.isFinite(hour) ? hour : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

function isWithinActiveWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function formatHourLabel(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  const period = normalized < 12 ? "AM" : "PM";
  const displayHour = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${displayHour}${period}`;
}

async function logDaypartingAction(input: {
  sellerId: string;
  campaignId: string;
  campaignName: string | null;
  action: string;
  reason: string | null;
  success: boolean;
  errorMessage?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("dayparting_action_log").insert({
    seller_id: input.sellerId,
    campaign_id: input.campaignId,
    campaign_name: input.campaignName,
    action: input.action,
    reason: input.reason,
    success: input.success,
    error_message: input.errorMessage ?? null
  });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not write dayparting action log entry.", error);
  }
}

async function upsertCampaignState(input: {
  sellerId: string;
  campaignId: string;
  campaignName: string | null;
  pausedBySystem: boolean;
  lastAction: string;
  lastError: string | null;
}): Promise<void> {
  const { error } = await supabase.from("dayparting_campaign_state").upsert(
    {
      seller_id: input.sellerId,
      campaign_id: input.campaignId,
      campaign_name: input.campaignName,
      paused_by_system: input.pausedBySystem,
      last_action: input.lastAction,
      last_action_at: new Date().toISOString(),
      last_error: input.lastError,
      updated_at: new Date().toISOString()
    },
    { onConflict: "seller_id,campaign_id" }
  );

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not update dayparting campaign state.", error);
  }
}

// The core automatic check, called every background-sync tick (see
// background-sync.service.ts) and also available as a founder-triggered
// "Run check now" endpoint for a first live test. Safety rules baked in:
//  - does nothing at all unless the founder has turned dayparting on
//  - only ever pauses a campaign that is currently genuinely ENABLED
//  - only ever resumes a campaign that THIS feature previously paused
//    (tracked in dayparting_campaign_state) and that is still PAUSED now --
//    it never force-enables a campaign it didn't touch, and never
//    "un-pauses" a campaign the founder paused for their own reason
//  - a single campaign's Amazon API failure never blocks the others
export async function runDaypartingCheck(sellerId: string): Promise<DaypartingCheckResult> {
  const settings = await getOrCreateDaypartingSettings(sellerId);

  if (!settings.enabled) {
    return {
      ran: false,
      summary: "Dayparting: off.",
      currentlyActiveHours: null,
      pausedCount: 0,
      resumedCount: 0,
      failedCount: 0
    };
  }

  const context = await loadAmazonAdsCampaignContext(sellerId);
  if (!context.ok) {
    return {
      ran: false,
      summary: "Dayparting: no connected Amazon Ads account, skipped.",
      currentlyActiveHours: null,
      pausedCount: 0,
      resumedCount: 0,
      failedCount: 0
    };
  }

  const hour = getHourInTimeZone(new Date(), settings.timezone);
  const shouldBeActive = isWithinActiveWindow(hour, settings.activeStartHour, settings.activeEndHour);
  const windowLabel = `${formatHourLabel(settings.activeStartHour)}–${formatHourLabel(settings.activeEndHour)}`;

  let liveCampaigns;
  let accessToken: string;
  try {
    accessToken = await getAmazonAdsAccessToken(context.connection.id);
    liveCampaigns = await getSponsoredProductsCampaignsWithRaw({
      accessToken,
      region: context.connection.region,
      profileId: context.profile.profile_id,
      connectionId: context.connection.id
    });

    // Keep the synced campaigns table fresh as a side effect, same data
    // every other part of the app reads.
    await saveAmazonAdsCampaigns({
      connectionId: context.connection.id,
      profileId: context.profile.profile_id,
      sellerId: context.connection.seller_id ?? sellerId,
      campaigns: liveCampaigns
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.warn("Dayparting check could not load live campaign state.", { sellerId, message });
    return {
      ran: false,
      summary: `Dayparting: could not check Amazon Ads right now (${message}).`,
      currentlyActiveHours: shouldBeActive,
      pausedCount: 0,
      resumedCount: 0,
      failedCount: 0
    };
  }

  const effectiveSellerId = context.connection.seller_id ?? sellerId;
  const byId = new Map(liveCampaigns.map((campaign) => [campaign.campaignId, campaign]));

  let pausedCount = 0;
  let resumedCount = 0;
  let failedCount = 0;

  if (!shouldBeActive) {
    const toPause = liveCampaigns.filter((campaign) => (campaign.state ?? "").toUpperCase() === "ENABLED");

    if (toPause.length > 0) {
      const outcomes = await updateSponsoredProductsCampaignStates({
        accessToken,
        region: context.connection.region,
        profileId: context.profile.profile_id,
        connectionId: context.connection.id,
        updates: toPause.map((campaign) => ({ campaignId: campaign.campaignId, state: "PAUSED" as const }))
      });

      for (const outcome of outcomes) {
        const campaign = byId.get(outcome.campaignId);
        if (outcome.success) {
          pausedCount += 1;
          await upsertCampaignState({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            pausedBySystem: true,
            lastAction: "PAUSED",
            lastError: null
          });
          await logDaypartingAction({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            action: "PAUSED",
            reason: `Outside active hours (${windowLabel} ${settings.timezone}).`,
            success: true
          });
        } else {
          failedCount += 1;
          await upsertCampaignState({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            pausedBySystem: false,
            lastAction: "PAUSE_FAILED",
            lastError: outcome.errorMessage ?? "Unknown error"
          });
          await logDaypartingAction({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            action: "PAUSE_FAILED",
            reason: `Outside active hours (${windowLabel} ${settings.timezone}).`,
            success: false,
            errorMessage: outcome.errorMessage
          });
        }
      }
    }
  } else {
    const systemPaused = (await listDaypartingCampaignStates(effectiveSellerId)).filter((row) => row.pausedBySystem);
    const toResume = systemPaused.filter((row) => {
      const live = byId.get(row.campaignId);
      return live && (live.state ?? "").toUpperCase() === "PAUSED";
    });
    // Any campaign this feature marked as system-paused but that is no longer PAUSED
    // live (someone else changed it, or it's gone) just has its flag cleared below --
    // never touched via the API, since it was never ours to force back to any state.
    const noLongerOurs = systemPaused.filter((row) => {
      const live = byId.get(row.campaignId);
      return !live || (live.state ?? "").toUpperCase() !== "PAUSED";
    });

    for (const row of noLongerOurs) {
      await upsertCampaignState({
        sellerId: effectiveSellerId,
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        pausedBySystem: false,
        lastAction: "RELEASED",
        lastError: null
      });
    }

    if (toResume.length > 0) {
      const outcomes = await updateSponsoredProductsCampaignStates({
        accessToken,
        region: context.connection.region,
        profileId: context.profile.profile_id,
        connectionId: context.connection.id,
        updates: toResume.map((row) => ({ campaignId: row.campaignId, state: "ENABLED" as const }))
      });

      for (const outcome of outcomes) {
        const campaign = byId.get(outcome.campaignId);
        if (outcome.success) {
          resumedCount += 1;
          await upsertCampaignState({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            pausedBySystem: false,
            lastAction: "RESUMED",
            lastError: null
          });
          await logDaypartingAction({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            action: "RESUMED",
            reason: `Active hours started (${windowLabel} ${settings.timezone}).`,
            success: true
          });
        } else {
          failedCount += 1;
          await upsertCampaignState({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            pausedBySystem: true,
            lastAction: "RESUME_FAILED",
            lastError: outcome.errorMessage ?? "Unknown error"
          });
          await logDaypartingAction({
            sellerId: effectiveSellerId,
            campaignId: outcome.campaignId,
            campaignName: campaign?.name ?? null,
            action: "RESUME_FAILED",
            reason: `Active hours started (${windowLabel} ${settings.timezone}).`,
            success: false,
            errorMessage: outcome.errorMessage
          });
        }
      }
    }
  }

  const windowState = shouldBeActive ? "active hours" : "outside active hours";
  const parts = [`Dayparting: ${windowState} (${windowLabel} ${settings.timezone}).`];
  if (pausedCount > 0) parts.push(`Paused ${pausedCount} campaign(s).`);
  if (resumedCount > 0) parts.push(`Resumed ${resumedCount} campaign(s).`);
  if (failedCount > 0) parts.push(`${failedCount} update(s) failed -- see history.`);
  if (pausedCount === 0 && resumedCount === 0 && failedCount === 0) parts.push("Nothing to change.");

  return {
    ran: true,
    summary: parts.join(" "),
    currentlyActiveHours: shouldBeActive,
    pausedCount,
    resumedCount,
    failedCount
  };
}
