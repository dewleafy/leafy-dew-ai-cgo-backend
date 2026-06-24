import { supabase } from "../../db/supabase";
import { AmazonAdsProfile } from "./amazon-ads.types";
import { logSafeAmazonAdsSupabaseError } from "./amazon-ads-client.service";

export async function saveAmazonAdsProfiles(
  connectionId: string,
  profiles: AmazonAdsProfile[]
): Promise<void> {
  if (profiles.length === 0) {
    return;
  }

  const rows = profiles.map((profile) => ({
    connection_id: connectionId,
    profile_id: String(profile.profileId),
    country_code: profile.countryCode ?? null,
    currency_code: profile.currencyCode ?? null,
    timezone: profile.timezone ?? null,
    account_info: profile.accountInfo ?? null
  }));

  const { error } = await supabase.from("amazon_ads_profiles").upsert(rows, {
    onConflict: "connection_id,profile_id"
  });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not save Amazon Ads profiles.", error);
    throw new Error(`Could not save Amazon Ads profiles: ${error.message}`);
  }
}

export async function listAmazonAdsProfiles(connectionId: string): Promise<unknown[]> {
  const { data, error } = await supabase
    .from("amazon_ads_profiles")
    .select("profile_id, country_code, currency_code, timezone, account_info, updated_at")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: true });

  if (error) {
    logSafeAmazonAdsSupabaseError("Could not load Amazon Ads profiles.", error);
    throw new Error(`Could not load Amazon Ads profiles: ${error.message}`);
  }

  return data ?? [];
}
