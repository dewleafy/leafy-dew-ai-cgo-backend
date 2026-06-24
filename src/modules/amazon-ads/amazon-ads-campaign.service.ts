import { supabase } from "../../db/supabase";
import { AmazonAdsCampaignWithRaw, SafeAmazonAdsCampaign } from "./amazon-ads.types";
import { logSafeAmazonAdsSupabaseError } from "./amazon-ads-client.service";

type SaveAmazonAdsCampaignsInput = {
  connectionId: string;
  profileId: string;
  sellerId: string;
  campaigns: AmazonAdsCampaignWithRaw[];
};

type SavedAmazonAdsCampaignRow = {
  campaign_id: string;
  name: string | null;
  campaign_type: string | null;
  targeting_type: string | null;
  state: string | null;
  status: string | null;
  daily_budget: number | string | null;
  start_date: string | null;
  end_date: string | null;
  last_synced_at: string | null;
};

function toSavedCampaign(row: SavedAmazonAdsCampaignRow): SafeAmazonAdsCampaign & { lastSyncedAt: string | null } {
  return {
    campaignId: row.campaign_id,
    name: row.name,
    campaignType: row.campaign_type,
    targetingType: row.targeting_type,
    state: row.state,
    status: row.status,
    dailyBudget: row.daily_budget,
    startDate: row.start_date,
    endDate: row.end_date,
    lastSyncedAt: row.last_synced_at
  };
}

export async function saveAmazonAdsCampaigns(input: SaveAmazonAdsCampaignsInput): Promise<number> {
  if (input.campaigns.length === 0) {
    return 0;
  }

  const syncedAt = new Date().toISOString();
  const rows = input.campaigns.map((campaign) => ({
    connection_id: input.connectionId,
    profile_id: input.profileId,
    seller_id: input.sellerId,
    campaign_id: campaign.campaignId,
    name: campaign.name,
    campaign_type: campaign.campaignType,
    targeting_type: campaign.targetingType,
    state: campaign.state,
    status: campaign.status,
    daily_budget: campaign.dailyBudget,
    start_date: campaign.startDate,
    end_date: campaign.endDate,
    raw_data: campaign.rawData,
    last_synced_at: syncedAt,
    updated_at: syncedAt
  }));

  const { error } = await supabase.from("amazon_ads_campaigns").upsert(rows, {
    onConflict: "profile_id,campaign_id"
  });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not save Amazon Ads campaigns.", error);
    throw new Error("Could not save Amazon Ads campaigns. Check the amazon_ads_campaigns table.");
  }

  return rows.length;
}

export async function listSavedAmazonAdsCampaigns(input: {
  connectionId: string;
  profileId: string;
}): Promise<Array<SafeAmazonAdsCampaign & { lastSyncedAt: string | null }>> {
  const { data, error } = await supabase
    .from("amazon_ads_campaigns")
    .select(
      "campaign_id, name, campaign_type, targeting_type, state, status, daily_budget, start_date, end_date, last_synced_at"
    )
    .eq("connection_id", input.connectionId)
    .eq("profile_id", input.profileId)
    .order("name", { ascending: true });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load saved Amazon Ads campaigns.", error);
    throw new Error("Could not load saved Amazon Ads campaigns.");
  }

  return ((data ?? []) as SavedAmazonAdsCampaignRow[]).map(toSavedCampaign);
}
