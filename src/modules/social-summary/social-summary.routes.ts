import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { supabase } from "../../db/supabase";

export const socialSummaryRouter = Router();

type D = { id: string; planned_date: string | null; slot_time: string | null; format: string | null; status: string; image_urls: unknown; video_url: string | null; media_note: string | null; occasion: string | null };

function ist(offset: number): string {
  return new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

// What is scheduled for the next 7 days and what is missing.
socialSummaryRouter.get("/", asyncHandler(async (_req, res) => {
  const from = ist(0);
  const to = ist(7);
  const { data: drafts, error } = await supabase
    .from("social_post_drafts")
    .select("id,planned_date,slot_time,format,status,image_urls,video_url,media_note,occasion")
    .eq("seller_id", "default").eq("platform", "INSTAGRAM").gte("planned_date", from).lte("planned_date", to)
    .order("planned_date").order("slot_time");
  if (error) throw new Error(error.message);

  const { data: logs } = await supabase.from("social_content_log").select("planned_date,content_type,title").eq("seller_id", "default").eq("platform", "INSTAGRAM").eq("status", "PLANNED").gte("planned_date", from).lte("planned_date", to);
  const drafted = new Set(((drafts ?? []) as D[]).map((d) => d.planned_date));

  const items = ((drafts ?? []) as D[]).map((d) => {
    const hasMedia = (Array.isArray(d.image_urls) && d.image_urls.length > 0) || Boolean(d.video_url);
    let state = "READY";
    let note = "Will post automatically at its time.";
    if (d.status === "DRAFT") { state = "NEEDS_APPROVAL"; note = "Waiting for your Approve."; }
    else if (d.status === "EDIT_REQUESTED") { state = "NEEDS_EDITS"; note = "Marked Needs edits. Will not post."; }
    else if (d.status === "HELD") { state = "HELD"; note = "On hold. Will not post."; }
    else if (!hasMedia) { state = "MEDIA_PENDING"; note = d.media_note?.startsWith("Held") || d.media_note?.startsWith("Failed") ? d.media_note : "Picture or video will be made 2 days before."; }
    return { id: d.id, date: d.planned_date, time: d.slot_time, format: d.format, occasion: d.occasion, state, note };
  });
  const noDraft = ((logs ?? []) as { planned_date: string | null; content_type: string | null; title: string | null }[])
    .filter((l) => !drafted.has(l.planned_date))
    .map((l) => ({ date: l.planned_date, format: l.content_type, title: l.title }));

  const { data: posted } = await supabase.from("social_autopost_log").select("created_at,permalink").eq("seller_id", "default").eq("outcome", "POSTED").gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString());
  res.json({ ok: true, items, noDraft, postedLast7Days: (posted ?? []).length });
}));
