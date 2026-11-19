import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { MEDIA_BUCKET } from "../social-media/social-media.service";
import { renderGreeting, stripEmoji } from "./render";
import { makeReelMp4 } from "./video";

// Creative studio: makes the picture or video for approved drafts a day or two before they are due.
// - Greeting graphics are drawn from the brand template.
// - Reels are built from the product's Amazon listing photos.
// - Photo and carousel posts get listing photos.
// Greetings whose date is still marked to confirm are HELD. The owner's Approve is the release for language lines.

type Draft = {
  id: string;
  planned_date: string | null;
  format: string | null;
  occasion: string | null;
  caption: string;
  product_asin: string | null;
  image_urls: unknown;
  video_url: string | null;
  media_note: string | null;
};

type Product = { asin: string; family: string | null; title: string | null };

const FAMILY_BY_TEXT: [RegExp, string][] = [
  [/lantern|tealight|deepam|diya|lamp|candle/i, "Lantern"],
  [/terrarium|hanging/i, "Terrarium"],
  [/propagation/i, "Wall propagation station"],
  [/test tube|vase/i, "Glass test tube planter"],
  [/planter|pot\b/i, "Planter / pot"],
  [/buddha/i, "Buddha statue"]
];

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function jpegs(urls: unknown): string[] {
  const list = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string") : [];
  return Array.from(new Set(list.filter((u) => u.startsWith("https://") && /\.jpe?g$/i.test(u))));
}

async function upload(pathInBucket: string, body: Buffer, contentType: string): Promise<string> {
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(pathInBucket, body, { contentType, upsert: true });
  if (error) throw new Error(error.message);
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(pathInBucket).data.publicUrl;
}

function captionLines(caption: string): string[] {
  return caption
    .split("\n")
    .map((l) => stripEmoji(l))
    .filter((l) => l && !/^link in bio/i.test(l));
}

async function pickProduct(draft: Draft, count: number, used: Map<string, number>): Promise<{ asin: string; photos: string[] } | null> {
  if (draft.product_asin) {
    const { data } = await supabase.from("amazon_listing_details").select("image_urls").eq("asin", draft.product_asin).limit(1).maybeSingle();
    const photos = jpegs((data as { image_urls?: unknown } | null)?.image_urls);
    if (photos.length >= count) return { asin: draft.product_asin, photos: photos.slice(0, count) };
  }
  const text = `${draft.occasion ?? ""} ${draft.caption}`;
  const family = FAMILY_BY_TEXT.find(([re]) => re.test(text))?.[1] ?? null;
  let query = supabase.from("social_products").select("asin,family,title").eq("seller_id", "default").eq("brand", "Leafy Dew").eq("post_status", "OK").eq("listing_status", "BUYABLE");
  if (family) query = query.eq("family", family);
  const { data: products } = await query;
  const ranked = ((products ?? []) as Product[]).sort((a, b) => (used.get(a.asin) ?? 0) - (used.get(b.asin) ?? 0));
  for (const p of ranked.slice(0, 6)) {
    const { data } = await supabase.from("amazon_listing_details").select("image_urls").eq("asin", p.asin).limit(1).maybeSingle();
    const photos = jpegs((data as { image_urls?: unknown } | null)?.image_urls);
    if (photos.length >= count) return { asin: p.asin, photos: photos.slice(0, count) };
  }
  return null;
}

export type PrepareReport = { made: string[]; held: string[]; failed: string[] };

export async function prepareUpcomingMedia(opts: { forceIds?: string[]; days?: number } = {}): Promise<PrepareReport> {
  const report: PrepareReport = { made: [], held: [], failed: [] };
  const today = istDate(0);
  const until = istDate(opts.days ?? 2);

  const { data, error } = await supabase
    .from("social_post_drafts")
    .select("id,planned_date,format,occasion,caption,product_asin,image_urls,video_url,media_note")
    .eq("seller_id", "default")
    .eq("platform", "INSTAGRAM")
    .eq("status", "APPROVED")
    .gte("planned_date", today)
    .lte("planned_date", until);
  if (error) throw new Error(error.message);

  const { data: usedRows } = await supabase.from("social_post_drafts").select("product_asin").not("product_asin", "is", null);
  const used = new Map<string, number>();
  for (const r of (usedRows ?? []) as { product_asin: string }[]) used.set(r.product_asin, (used.get(r.product_asin) ?? 0) + 1);

  for (const d of (data ?? []) as Draft[]) {
    const forced = opts.forceIds?.includes(d.id) ?? false;
    const hasMedia = jpegs(d.image_urls).length > 0 || Boolean(d.video_url);
    if (hasMedia) continue;
    if (!forced && d.media_note && /^(Held|Failed)/.test(d.media_note)) continue;
    const format = d.format ?? "";
    const label = `${d.planned_date} ${format}`;

    try {
      if (/greeting/i.test(format)) {
        if (!forced && /confirm/i.test(d.occasion ?? "")) {
          await supabase.from("social_post_drafts").update({ media_note: "Held: the date is still to be confirmed. Owner must confirm it, then run Prepare with this draft." }).eq("id", d.id);
          report.held.push(label);
          continue;
        }
        const lines = captionLines(d.caption);
        const url = await upload(`generated/greetings/${d.id}.jpg`, await renderGreeting({ headline: (d.occasion ?? "Greetings").replace(/\s*\(.*?\)\s*/g, "").trim(), lines }), "image/jpeg");
        await supabase.from("social_post_drafts").update({ image_urls: [url], media_note: "Greeting graphic made automatically." }).eq("id", d.id);
        report.made.push(label);
      } else if (/reel/i.test(format)) {
        const pick = await pickProduct(d, 4, used);
        if (!pick) throw new Error("No buyable product with photos found");
        const mp4 = await makeReelMp4({ photoUrls: pick.photos, lines: captionLines(d.caption) });
        const url = await upload(`generated/reels/${d.id}.mp4`, mp4, "video/mp4");
        await supabase.from("social_post_drafts").update({ video_url: url, product_asin: pick.asin, media_note: "Reel made automatically from listing photos (silent, about 14 seconds)." }).eq("id", d.id);
        used.set(pick.asin, (used.get(pick.asin) ?? 0) + 1);
        report.made.push(label);
      } else if (/carousel|feed photo|photo/i.test(format)) {
        const count = /carousel/i.test(format) ? 3 : 1;
        const pick = await pickProduct(d, count, used);
        if (!pick) throw new Error("No buyable product with photos found");
        await supabase.from("social_post_drafts").update({ image_urls: pick.photos, product_asin: pick.asin, media_note: "Listing photos attached automatically." }).eq("id", d.id);
        used.set(pick.asin, (used.get(pick.asin) ?? 0) + 1);
        report.made.push(label);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      await supabase.from("social_post_drafts").update({ media_note: `Failed: ${message}`.slice(0, 300) }).eq("id", d.id);
      logger.error("Creative studio failed.", { draftId: d.id, message });
      report.failed.push(`${label} (${message})`);
    }
  }
  return report;
}
