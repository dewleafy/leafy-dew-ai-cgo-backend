import { supabase } from "../../db/supabase";
import {
  CreateSocialContentLogInput,
  SafeSocialContentLogRow,
  SocialContentCalendarSummary,
  SocialContentLogRow,
  SocialContentPlatform,
  SocialContentStatus,
  UpdateSocialContentLogInput
} from "./social-content-log.types";

export const SOCIAL_CONTENT_PLATFORMS: SocialContentPlatform[] = [
  "INSTAGRAM",
  "FACEBOOK",
  "YOUTUBE",
  "PINTEREST",
  "OTHER"
];

export const SOCIAL_CONTENT_STATUSES: SocialContentStatus[] = ["PLANNED", "POSTED", "SKIPPED"];

function toSafeRow(row: SocialContentLogRow): SafeSocialContentLogRow {
  return {
    id: row.id,
    sellerId: row.seller_id,
    platform: row.platform,
    contentType: row.content_type,
    title: row.title,
    sku: row.sku,
    asin: row.asin,
    status: row.status,
    plannedDate: row.planned_date,
    postedDate: row.posted_date,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listSocialContentLog(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeSocialContentLogRow[]> {
  const { data, error } = await supabase
    .from("social_content_log")
    .select("*")
    .eq("seller_id", input.sellerId)
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (error) {
    throw new Error(`Could not load social content log from Supabase. (${error.message})`);
  }

  return ((data ?? []) as SocialContentLogRow[]).map(toSafeRow);
}

export async function createSocialContentLogEntry(
  input: CreateSocialContentLogInput
): Promise<SafeSocialContentLogRow> {
  const { data, error } = await supabase
    .from("social_content_log")
    .insert({
      seller_id: input.sellerId,
      platform: input.platform,
      content_type: input.contentType,
      title: input.title,
      sku: input.sku,
      asin: input.asin,
      status: input.status,
      planned_date: input.plannedDate,
      posted_date: input.postedDate,
      notes: input.notes
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Could not save social content log entry in Supabase. (${error?.message ?? "no row returned"})`);
  }

  return toSafeRow(data as SocialContentLogRow);
}

export async function updateSocialContentLogEntry(
  id: string,
  input: UpdateSocialContentLogInput
): Promise<SafeSocialContentLogRow | null> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.platform !== undefined) patch.platform = input.platform;
  if (input.contentType !== undefined) patch.content_type = input.contentType;
  if (input.title !== undefined) patch.title = input.title;
  if (input.sku !== undefined) patch.sku = input.sku;
  if (input.asin !== undefined) patch.asin = input.asin;
  if (input.status !== undefined) patch.status = input.status;
  if (input.plannedDate !== undefined) patch.planned_date = input.plannedDate;
  if (input.postedDate !== undefined) patch.posted_date = input.postedDate;
  if (input.notes !== undefined) patch.notes = input.notes;

  const { data, error } = await supabase
    .from("social_content_log")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`Could not update social content log entry in Supabase. (${error.message})`);
  }

  return data ? toSafeRow(data as SocialContentLogRow) : null;
}

// A founder deleting their own manually-entered log row is an ordinary single-record edit,
// not a mass-delete - this only ever removes the one row matching `id`.
export async function deleteSocialContentLogEntry(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("social_content_log")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Could not delete social content log entry in Supabase. (${error.message})`);
  }

  return Boolean(data);
}

// Real, computed-from-real-rows summary for the Social Content engines (SOCIAL_CALENDAR_CHECK).
// windowDays defines what counts as "recent" for the posted-content side of the check.
export async function getSocialContentCalendarSummary(
  sellerId: string,
  windowDays: number
): Promise<SocialContentCalendarSummary> {
  const { data, error } = await supabase
    .from("social_content_log")
    .select("status, planned_date, posted_date")
    .eq("seller_id", sellerId);

  if (error) {
    throw new Error(`Could not load social content log from Supabase. (${error.message})`);
  }

  const rows = (data ?? []) as Array<Pick<SocialContentLogRow, "status" | "planned_date" | "posted_date">>;
  const now = Date.now();
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

  let mostRecentPostedDate: string | null = null;
  let mostRecentPostedTime = -Infinity;
  let postedInWindowCount = 0;

  let nextPlannedDate: string | null = null;
  let nextPlannedTime = Infinity;

  for (const row of rows) {
    if (row.status === "POSTED" && row.posted_date) {
      const postedTime = new Date(row.posted_date).getTime();
      if (Number.isFinite(postedTime)) {
        if (postedTime > mostRecentPostedTime) {
          mostRecentPostedTime = postedTime;
          mostRecentPostedDate = row.posted_date;
        }
        if (postedTime >= windowStart) {
          postedInWindowCount += 1;
        }
      }
    }

    if (row.status === "PLANNED" && row.planned_date) {
      const plannedTime = new Date(row.planned_date).getTime();
      if (Number.isFinite(plannedTime) && plannedTime >= now && plannedTime < nextPlannedTime) {
        nextPlannedTime = plannedTime;
        nextPlannedDate = row.planned_date;
      }
    }
  }

  const daysSinceLastPost = mostRecentPostedDate
    ? Math.floor((now - mostRecentPostedTime) / (24 * 60 * 60 * 1000))
    : null;
  const daysUntilNextPlanned = nextPlannedDate
    ? Math.ceil((nextPlannedTime - now) / (24 * 60 * 60 * 1000))
    : null;

  return {
    totalLoggedEver: rows.length,
    postedInWindowCount,
    mostRecentPostedDate,
    daysSinceLastPost,
    nextPlannedDate,
    daysUntilNextPlanned
  };
}
