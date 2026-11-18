import { supabase } from "../../db/supabase";
import { generateAiResponse } from "../ai-gateway/ai-gateway.service";

// Writes Instagram photo and carousel drafts for planned days. It only creates DRAFT rows for the
// owner to approve. It never posts anything. Every AI call goes through the AI gateway, so it is
// capped and recorded in the AI cost ledger.

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /(₹|\brs\.?\s?\d|\binr\b|\bprice|\bcost\b|\bcheap|\baffordable|\bdiscount|\boffer|\bsale\b|\bdeal\b|% ?off|free shipping|\blimited\b|\bhurry)/i, why: "price, offer or urgency wording" },
  { re: /(\bbest\b|#1|\bnumber one|guarantee|100 ?%|\bperfect\b|\bunbreakable|\bforever\b|\bnever\b|\balways\b)/i, why: "absolute or superlative claim" },
  { re: /(\bheal|\bcure|\bwealth|\bluck|\bprosper|\bmoney magnet|\bcleanse|\bmiracle)/i, why: "wealth, luck or healing claim" },
  { re: /(\bwaterproof|\brust[- ]?proof|\bpet[- ]safe|\bnon[- ]?toxic|\bbpa)/i, why: "unverified product claim" }
];

const FAMILY_HINTS: [RegExp, string][] = [
  [/propagation|wall test tube/i, "Wall propagation station"],
  [/terrarium/i, "Terrarium"],
  [/lantern|candle/i, "Lantern"],
  [/planter|pot/i, "Planter / pot"],
  [/glass vase|test tube planter|wooden holder/i, "Glass test tube planter"],
  [/buddha/i, "Buddha statue"],
  [/lamp|light/i, "Test tube LED lamp"],
  [/bottle/i, "Ceramic glass bottle set"]
];

type LogRow = { id: string; planned_date: string | null; content_type: string | null; title: string | null; notes: string | null };
type Product = { asin: string; title: string | null; family: string | null; brand: string };

export type WriterResult = {
  created: { draftId: string; date: string | null; product: string; format: string }[];
  skipped: { date: string | null; reason: string }[];
  aiBlocked: string | null;
};

function parseNotes(notes: string | null) {
  const parts = (notes ?? "").split("|").map((part) => part.trim());
  const time = parts.find((part) => /^\d{1,2}:\d{2}\s*IST/i.test(part)) ?? null;
  const timeIdx = time ? parts.indexOf(time) : -1;
  return {
    slot: time ? time.replace(/\s*IST/i, "").trim() : null,
    stage: timeIdx >= 0 ? parts[timeIdx + 1] ?? null : null,
    familyText: timeIdx >= 0 ? parts[timeIdx + 2] ?? "" : "",
    idea: timeIdx >= 0 ? parts[timeIdx + 3] ?? "" : ""
  };
}

function countEmoji(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

export function checkCaption(caption: string, hashtags: string[]): string[] {
  const problems: string[] = [];
  const combined = `${caption}\n${hashtags.join(" ")}`;
  for (const rule of FORBIDDEN) if (rule.re.test(combined)) problems.push(rule.why);
  if (hashtags.length < 3 || hashtags.length > 5) problems.push("hashtags must be 3 to 5");
  if (countEmoji(combined) > 2) problems.push("more than 2 emoji");
  if (/#/.test(caption)) problems.push("hashtags must not be inside the caption text");
  if (caption.length < 40) problems.push("caption too short");
  if (caption.length + hashtags.join(" ").length > 2000) problems.push("caption too long");
  return problems;
}

function pickJpegs(urls: unknown, count: number): string[] {
  const list = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string") : [];
  const jpegs = list.filter((u) => u.startsWith("https://") && /\.jpe?g$/i.test(u));
  return Array.from(new Set(jpegs)).slice(0, count);
}

function parseModelJson(text: string): { caption: string; hashtags: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as { caption?: unknown; hashtags?: unknown };
    if (typeof data.caption !== "string") return null;
    const tags = Array.isArray(data.hashtags)
      ? data.hashtags.map((tag) => String(tag).trim()).filter(Boolean).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
      : [];
    return { caption: data.caption.trim(), hashtags: tags };
  } catch {
    return null;
  }
}

function buildPrompt(input: { product: Product; bullets: string[]; occasion: string; idea: string; format: string; fix: string[] }): string {
  return [
    "You write one Instagram caption for Leafy Dew, an Indian home and garden decor brand (@leafy_dew).",
    "Voice: warm, plain, short sentences. Say 'we' for the brand. No hype.",
    "Hard rules:",
    "- Use ONLY the product facts below. Do not invent materials, sizes, contents, uses, or benefits.",
    "- No price, discount, offer, sale, free delivery or urgency words.",
    "- No words like best, perfect, guaranteed, always, never, forever, 100%.",
    "- No wealth, luck, healing or spiritual-benefit claims.",
    "- At most 2 emoji in total. 3 to 5 hashtags, listed separately, never inside the caption text.",
    "- 2 to 4 short sentences. End the caption with exactly: Link in bio to see it on Amazon.",
    `Post type: ${input.format}. Occasion or theme: ${input.occasion}. Idea from the plan: ${input.idea || "none"}.`,
    `Product name: ${input.product.title ?? ""}`,
    `Product facts from the listing: ${input.bullets.slice(0, 6).join(" | ") || "none given"}`,
    input.fix.length ? `Your last attempt broke these rules: ${input.fix.join("; ")}. Fix them.` : "",
    'Reply with only JSON: {"caption":"...","hashtags":["#LeafyDew","#..."]}'
  ].filter(Boolean).join("\n");
}

export async function writeNextDrafts(input: { sellerId: string; days: number; limit: number }): Promise<WriterResult> {
  const result: WriterResult = { created: [], skipped: [], aiBlocked: null };
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + input.days * 86400000).toISOString().slice(0, 10);

  const { data: logs, error } = await supabase
    .from("social_content_log")
    .select("id,planned_date,content_type,title,notes")
    .eq("seller_id", input.sellerId)
    .eq("status", "PLANNED")
    .eq("platform", "INSTAGRAM")
    .gte("planned_date", today)
    .lte("planned_date", until)
    .order("planned_date", { ascending: true });
  if (error) throw new Error(error.message);

  const { data: existing } = await supabase.from("social_post_drafts").select("content_log_id,product_asin,created_at").eq("seller_id", input.sellerId);
  const hasDraft = new Set((existing ?? []).map((row) => (row as { content_log_id: string | null }).content_log_id).filter(Boolean));
  const recentlyUsed = new Set(
    (existing ?? []).filter((row) => (row as { product_asin: string | null }).product_asin).map((row) => (row as { product_asin: string }).product_asin)
  );

  const { data: products } = await supabase
    .from("social_products")
    .select("asin,title,family,brand,listing_status")
    .eq("seller_id", input.sellerId)
    .eq("brand", "Leafy Dew")
    .eq("post_status", "OK")
    .eq("listing_status", "BUYABLE");
  const pool = (products ?? []) as Product[];

  let made = 0;
  for (const log of (logs ?? []) as LogRow[]) {
    if (made >= input.limit) break;
    if (hasDraft.has(log.id)) continue;
    const type = log.content_type ?? "";
    const isCarousel = /carousel/i.test(type);
    if (!/feed photo/i.test(type) && !isCarousel) {
      result.skipped.push({ date: log.planned_date, reason: `${type || "This post type"} needs video, not built yet` });
      continue;
    }

    const plan = parseNotes(log.notes);
    const wantedFamily = FAMILY_HINTS.find(([re]) => re.test(plan.familyText))?.[1] ?? null;
    let candidates = wantedFamily ? pool.filter((p) => p.family === wantedFamily) : [];
    if (candidates.length === 0) candidates = pool;
    candidates = [...candidates].sort((a, b) => Number(recentlyUsed.has(a.asin)) - Number(recentlyUsed.has(b.asin)));

    let drafted = false;
    for (const product of candidates.slice(0, 4)) {
      const { data: detail } = await supabase.from("amazon_listing_details").select("image_urls,bullets").eq("asin", product.asin).limit(1).maybeSingle();
      const images = pickJpegs((detail as { image_urls?: unknown } | null)?.image_urls, isCarousel ? 3 : 1);
      if (images.length < (isCarousel ? 3 : 1)) continue;
      const rawBullets = (detail as { bullets?: unknown } | null)?.bullets;
      const bullets = Array.isArray(rawBullets) ? rawBullets.filter((b): b is string => typeof b === "string") : [];

      const occasion = plan.stage ?? log.title ?? "Evergreen";
      let fix: string[] = [];
      let best: { caption: string; hashtags: string[] } | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const ai = await generateAiResponse({
          sellerId: input.sellerId,
          moduleName: "SOCIAL_WRITER",
          purpose: "Instagram caption draft",
          prompt: buildPrompt({ product, bullets, occasion, idea: plan.idea, format: isCarousel ? "carousel of 3 photos" : "single photo", fix }),
          maxOutputTokens: 500,
          actor: "social-writer",
          metadata: { asin: product.asin, logId: log.id }
        });
        if (!ai.ok || !ai.output) {
          result.aiBlocked = ai.blockedReason ?? "AI_FAILED";
          return result;
        }
        const parsed = parseModelJson(ai.output);
        if (!parsed) { fix = ["reply was not valid JSON"]; continue; }
        const problems = checkCaption(parsed.caption, parsed.hashtags);
        if (problems.length === 0) { best = parsed; break; }
        fix = problems;
      }
      if (!best) {
        result.skipped.push({ date: log.planned_date, reason: `Caption for ${product.asin} failed checks: ${fix.join(", ")}` });
        continue;
      }

      const { data: saved, error: saveError } = await supabase
        .from("social_post_drafts")
        .insert({
          seller_id: input.sellerId,
          content_log_id: log.id,
          planned_date: log.planned_date,
          slot_time: plan.slot,
          platform: "INSTAGRAM",
          format: isCarousel ? "Carousel (3 images)" : "Feed photo",
          occasion,
          caption: best.caption,
          hashtags: best.hashtags.join(" "),
          creative_brief: `Uses ${images.length} listing photo${images.length > 1 ? "s" : ""} of this product. Swap in your own photo from the Media Library if you prefer.`,
          checks: `Auto-checked: no price, offer, absolute or unverified claims; ${best.hashtags.length} hashtags; at most 2 emoji. Product facts from the Amazon listing only. Please read once before approving.`,
          product_asin: product.asin,
          image_urls: images,
          status: "DRAFT"
        })
        .select("id")
        .single();
      if (saveError || !saved) throw new Error(saveError?.message ?? "Could not save draft.");

      recentlyUsed.add(product.asin);
      result.created.push({ draftId: (saved as { id: string }).id, date: log.planned_date, product: product.title ?? product.asin, format: isCarousel ? "Carousel" : "Feed photo" });
      made += 1;
      drafted = true;
      break;
    }
    if (!drafted && !result.skipped.some((s) => s.date === log.planned_date)) {
      result.skipped.push({ date: log.planned_date, reason: "No buyable product with usable JPEG photos found" });
    }
  }
  return result;
}
