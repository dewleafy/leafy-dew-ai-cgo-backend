import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { publishInstagramPost } from "../instagram-publish/instagram-publish.service";
import { prepareUpcomingMedia } from "../creative-studio/creative-studio.service";

// Posts approved drafts on their planned day and time (IST).
// Modes: OFF = does nothing. SHADOW = checks everything and records "would post", publishes nothing.
// LIVE = publishes, but only after 4 weeks of shadow mode and with INSTAGRAM_PUBLISH_ENABLED=true.
// At most one post per day. A draft can never be published twice (unique index in the database).

export type AutopostMode = "OFF" | "SHADOW" | "LIVE";
const SHADOW_DAYS_REQUIRED = 28;
const SELLER = "default";

type Draft = {
  id: string;
  content_log_id: string | null;
  planned_date: string | null;
  slot_time: string | null;
  format: string | null;
  caption: string;
  hashtags: string | null;
  product_asin: string | null;
  image_urls: unknown;
  video_url: string | null;
};

function istNow(): { date: string; minutes: number } {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

function slotMinutes(slot: string | null): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(slot ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60 + 30;
}

export async function getAutopostSettings(sellerId = SELLER) {
  const { data, error } = await supabase.from("social_autopost_settings").select("*").eq("seller_id", sellerId).maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as { mode: AutopostMode; shadow_started_at: string } | null) ?? { mode: "SHADOW" as AutopostMode, shadow_started_at: new Date().toISOString() };
  const days = Math.floor((Date.now() - new Date(row.shadow_started_at).getTime()) / 86400000);
  return {
    mode: row.mode,
    shadowStartedAt: row.shadow_started_at,
    shadowDays: days,
    shadowDaysRequired: SHADOW_DAYS_REQUIRED,
    liveAllowed: days >= SHADOW_DAYS_REQUIRED,
    publishSwitchOn: process.env.INSTAGRAM_PUBLISH_ENABLED?.trim().toLowerCase() === "true"
  };
}

export async function setAutopostMode(mode: AutopostMode, sellerId = SELLER) {
  const current = await getAutopostSettings(sellerId);
  if (mode === "LIVE" && !current.liveAllowed) {
    throw new Error(`Live posting unlocks after ${SHADOW_DAYS_REQUIRED} days of shadow mode. ${current.shadowDays} days done.`);
  }
  const patch: Record<string, unknown> = { seller_id: sellerId, mode, updated_at: new Date().toISOString() };
  if (mode === "SHADOW" && current.mode === "OFF") patch.shadow_started_at = current.shadowStartedAt;
  const { error } = await supabase.from("social_autopost_settings").upsert(patch, { onConflict: "seller_id" });
  if (error) throw new Error(error.message);
  return getAutopostSettings(sellerId);
}

export async function listAutopostLog(limit = 30, sellerId = SELLER) {
  const { data, error } = await supabase
    .from("social_autopost_log")
    .select("id,draft_id,mode,outcome,message,permalink,created_at")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function record(draftId: string, mode: string, outcome: string, message: string, extra: { mediaId?: string; permalink?: string | null } = {}) {
  const { error } = await supabase.from("social_autopost_log").insert({
    seller_id: SELLER, draft_id: draftId, mode, outcome, message, media_id: extra.mediaId ?? null, permalink: extra.permalink ?? null
  });
  if (error && !/duplicate key/i.test(error.message)) throw new Error(error.message);
  return !error;
}

function imagesOf(d: Draft): string[] {
  return Array.isArray(d.image_urls) ? d.image_urls.filter((u): u is string => typeof u === "string") : [];
}

async function problemWith(d: Draft): Promise<string | null> {
  const images = imagesOf(d);
  if (/reel/i.test(d.format ?? "")) {
    if (!d.video_url) return "Reel video not made yet";
    if (!d.video_url.startsWith("https://") || !/\.mp4(\?.*)?$/i.test(d.video_url)) return "Video is not a public MP4 link";
  } else if (images.length === 0) return "No photo attached to this draft yet";
  if (!d.video_url && images.some((u) => !u.startsWith("https://") || !/\.jpe?g(\?.*)?$/i.test(u))) return "Photo is not a public JPEG link";
  if (d.product_asin) {
    const { data } = await supabase.from("social_products").select("post_status,listing_status").eq("seller_id", SELLER).eq("asin", d.product_asin).maybeSingle();
    const p = data as { post_status: string; listing_status: string } | null;
    if (!p || p.post_status !== "OK" || p.listing_status !== "BUYABLE") return "Product is on hold or not buyable on Amazon right now";
  }
  if (d.caption.length < 20) return "Caption too short";
  return null;
}

export async function runAutopostOnce(): Promise<string> {
  const settings = await getAutopostSettings();
  if (settings.mode === "OFF") return "Auto-posting is OFF.";
  const now = istNow();

  const { data: drafts, error } = await supabase
    .from("social_post_drafts")
    .select("id,content_log_id,planned_date,slot_time,format,caption,hashtags,product_asin,image_urls,video_url")
    .eq("seller_id", SELLER)
    .eq("platform", "INSTAGRAM")
    .eq("status", "APPROVED")
    .eq("planned_date", now.date);
  if (error) throw new Error(error.message);

  const due = ((drafts ?? []) as Draft[]).filter((d) => slotMinutes(d.slot_time) <= now.minutes).sort((a, b) => slotMinutes(a.slot_time) - slotMinutes(b.slot_time));
  if (due.length === 0) return "Nothing due.";

  if (settings.mode === "LIVE") {
    const { data: already } = await supabase.from("social_autopost_log").select("id").eq("seller_id", SELLER).eq("outcome", "POSTED").gte("created_at", new Date(Date.now() - 20 * 3600000).toISOString()).limit(1);
    if ((already ?? []).length > 0) return "Already posted today.";
  }

  for (const d of due) {
    const problem = await problemWith(d);
    if (problem) {
      const { data: seen } = await supabase.from("social_autopost_log").select("id").eq("draft_id", d.id).eq("outcome", "SKIPPED").gte("created_at", `${now.date}T00:00:00+05:30`).limit(1);
      if ((seen ?? []).length === 0) await record(d.id, settings.mode, "SKIPPED", problem);
      continue;
    }
    const caption = `${d.caption}${d.hashtags ? `\n\n${d.hashtags}` : ""}`.slice(0, 2200);
    const images = imagesOf(d);

    if (settings.mode === "SHADOW") {
      const fresh = await record(d.id, "SHADOW", "WOULD_POST", `Would post ${d.video_url ? "a Reel" : images.length > 1 ? `a ${images.length}-photo carousel` : "1 photo"} at ${d.slot_time ?? "12:30"} IST. Nothing was published.`);
      if (fresh) logger.info("Autopost shadow: would post.", { draftId: d.id });
      continue;
    }

    if (!settings.publishSwitchOn) return "Live mode, but INSTAGRAM_PUBLISH_ENABLED is not true. Nothing posted.";
    // Claim the draft first. The unique index makes a double post impossible.
    const claimed = await record(d.id, "LIVE", "POSTING", "Posting now");
    if (!claimed) continue;
    try {
      const out = await publishInstagramPost({ imageUrls: images, videoUrl: /reel/i.test(d.format ?? "") ? d.video_url : null, caption });
      await supabase.from("social_autopost_log").update({ outcome: "POSTED", message: "Posted.", media_id: out.mediaId, permalink: out.permalink }).eq("draft_id", d.id).eq("outcome", "POSTING");
      if (d.content_log_id) {
        await supabase.from("social_content_log").update({ status: "POSTED", posted_date: now.date, notes: `Auto-posted. Media id ${out.mediaId}. ${out.permalink ?? ""}`.trim() }).eq("id", d.content_log_id);
      }
      return `Posted draft ${d.id}.`;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      await supabase.from("social_autopost_log").update({ outcome: "FAILED", message }).eq("draft_id", d.id).eq("outcome", "POSTING");
      // Failure stops the whole poster so nothing keeps retrying.
      await supabase.from("social_autopost_settings").update({ mode: "OFF", updated_at: new Date().toISOString() }).eq("seller_id", SELLER);
      logger.error("Autopost failed; switched to OFF.", { message });
      return `Post failed, auto-posting switched OFF: ${message}`;
    }
  }
  return "Checked due drafts.";
}

let running = false;
export function startSocialAutopostScheduler(): void {
  logger.info("Social auto-post scheduler starting, checks every 5 minutes.");
  setTimeout(() => {
    const tick = () => {
      if (running) return;
      running = true;
      prepareUpcomingMedia().then(() => runAutopostOnce()).catch((e) => logger.error("Autopost check failed.", { message: e instanceof Error ? e.message : String(e) })).finally(() => { running = false; });
    };
    tick();
    setInterval(tick, 5 * 60 * 1000);
  }, 60 * 1000);
}
