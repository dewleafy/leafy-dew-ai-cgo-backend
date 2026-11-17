import { supabase } from "../../db/supabase";
import {
  CreateSocialDraftInput,
  SafeSocialDraft,
  SocialDraftPlatform,
  SocialDraftRow,
  SocialDraftStatus,
  UpdateSocialDraftInput
} from "./social-drafts.types";

export const SOCIAL_DRAFT_STATUSES: SocialDraftStatus[] = ["DRAFT", "APPROVED", "EDIT_REQUESTED", "HELD"];
export const SOCIAL_DRAFT_PLATFORMS: SocialDraftPlatform[] = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "PINTEREST", "OTHER"];

function toSafeDraft(row: SocialDraftRow): SafeSocialDraft {
  return {
    id: row.id,
    sellerId: row.seller_id,
    contentLogId: row.content_log_id,
    plannedDate: row.planned_date,
    slotTime: row.slot_time,
    platform: row.platform,
    format: row.format,
    occasion: row.occasion,
    caption: row.caption,
    hashtags: row.hashtags,
    creativeBrief: row.creative_brief,
    checks: row.checks,
    status: row.status,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listSocialDrafts(input: {
  sellerId: string;
  status: SocialDraftStatus | null;
  limit: number;
}): Promise<SafeSocialDraft[]> {
  let query = supabase
    .from("social_post_drafts")
    .select("*")
    .eq("seller_id", input.sellerId)
    .order("planned_date", { ascending: true })
    .order("slot_time", { ascending: true })
    .limit(input.limit);

  if (input.status) {
    query = query.eq("status", input.status);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Could not load social drafts from Supabase. (${error.message})`);
  }

  return ((data ?? []) as SocialDraftRow[]).map(toSafeDraft);
}

export async function createSocialDrafts(inputs: CreateSocialDraftInput[]): Promise<SafeSocialDraft[]> {
  const { data, error } = await supabase
    .from("social_post_drafts")
    .insert(
      inputs.map((input) => ({
        seller_id: input.sellerId,
        content_log_id: input.contentLogId,
        planned_date: input.plannedDate,
        slot_time: input.slotTime,
        platform: input.platform,
        format: input.format,
        occasion: input.occasion,
        caption: input.caption,
        hashtags: input.hashtags,
        creative_brief: input.creativeBrief,
        checks: input.checks,
        status: "DRAFT"
      }))
    )
    .select("*");

  if (error || !data) {
    throw new Error(`Could not save social drafts in Supabase. (${error?.message ?? "no rows returned"})`);
  }

  return (data as SocialDraftRow[]).map(toSafeDraft);
}

// Records the owner's decision on one draft. This never publishes anything: approval only marks the
// draft as cleared, so a later publishing step (not built yet) can pick it up.
export async function updateSocialDraft(id: string, input: UpdateSocialDraftInput): Promise<SafeSocialDraft | null> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.caption !== undefined) patch.caption = input.caption;
  if (input.hashtags !== undefined) patch.hashtags = input.hashtags;
  if (input.decisionNote !== undefined) patch.decision_note = input.decisionNote;
  if (input.status !== undefined) {
    patch.status = input.status;
    patch.decided_at = input.status === "DRAFT" ? null : new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("social_post_drafts")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`Could not update social draft in Supabase. (${error.message})`);
  }

  return data ? toSafeDraft(data as SocialDraftRow) : null;
}
