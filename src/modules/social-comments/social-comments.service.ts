import { supabase } from "../../db/supabase";
import { generateAiResponse } from "../ai-gateway/ai-gateway.service";
import { fetchRecentInstagramComments, replyToInstagramComment } from "../instagram-publish/instagram-publish.service";

// Reads recent comments on @leafy_dew posts, drafts a reply in the brand voice, and waits for the owner.
// A reply is posted only when the owner presses Send. Comments that need a person are flagged.

const OWN_USERNAME = "leafy_dew";
const SELLER = "default";

export type CommentRow = {
  id: string; ig_comment_id: string; media_permalink: string | null; username: string | null; comment_text: string;
  commented_at: string | null; status: string; suggested_reply: string | null; reply_note: string | null; replied_at: string | null;
};

const BAD_REPLY = /(₹|\brs\.?\s?\d|\bprice|\bdiscount|\boffer|\bsale\b|% ?off|guarantee|100 ?%|\bcure|\bheal|\bwealth|\bluck)/i;

function countEmoji(t: string): number {
  return (t.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

function buildPrompt(comment: string, fix: string[]): string {
  return [
    "You reply to an Instagram comment for Leafy Dew, an Indian home and garden decor brand (@leafy_dew).",
    "Voice: warm, plain, one or two short sentences. Use 'we'. Reply in the same language as the comment (Hindi, English or other).",
    "Rules:",
    "- Never mention price, discount, offers, delivery promises, or health, luck or wealth benefits.",
    "- If they ask where to buy or ask for a link: say the link is in our bio.",
    "- If they ask about a product we may not have live: say it is not available yet and we will share it when it is.",
    "- Do not invent product facts. If you do not know, say we will check and come back.",
    "- At most 1 emoji. No hashtags.",
    "- If the comment is a complaint, an order or refund problem, a legal or health matter, abusive, or you are unsure, set needsOwner to true and write a short polite holding reply.",
    "- If it is only an emoji or a compliment, a short thank-you is enough.",
    fix.length ? `Your last attempt broke these rules: ${fix.join("; ")}. Fix them.` : "",
    `Comment: ${JSON.stringify(comment.slice(0, 500))}`,
    'Reply with only JSON: {"reply":"...","needsOwner":false}'
  ].filter(Boolean).join("\n");
}

async function draftReply(commentText: string): Promise<{ reply: string; needsOwner: boolean } | { blocked: string }> {
  let fix: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ai = await generateAiResponse({
      sellerId: SELLER, moduleName: "SOCIAL_WRITER", purpose: "Instagram comment reply draft",
      prompt: buildPrompt(commentText, fix), maxOutputTokens: 250, actor: "founder", metadata: {}
    });
    if (!ai.ok || !ai.output) return { blocked: ai.blockedReason ?? "AI_FAILED" };
    const s = ai.output.indexOf("{"); const e = ai.output.lastIndexOf("}");
    try {
      const data = JSON.parse(ai.output.slice(s, e + 1)) as { reply?: unknown; needsOwner?: unknown };
      const reply = String(data.reply ?? "").trim();
      const problems: string[] = [];
      if (!reply) problems.push("empty reply");
      if (BAD_REPLY.test(reply)) problems.push("price, offer or benefit wording");
      if (countEmoji(reply) > 1) problems.push("more than 1 emoji");
      if (reply.length > 300) problems.push("too long");
      if (problems.length === 0) return { reply, needsOwner: data.needsOwner === true };
      fix = problems;
    } catch { fix = ["reply was not valid JSON"]; }
  }
  return { reply: "Thank you for your comment! We will get back to you soon.", needsOwner: true };
}

export async function syncComments(): Promise<{ newComments: number; drafted: number; aiBlocked: string | null }> {
  const fetched = await fetchRecentInstagramComments();
  const mine = fetched.filter((c) => (c.username ?? "").toLowerCase() !== OWN_USERNAME);
  if (mine.length > 0) {
    const { data: existing } = await supabase.from("social_comments").select("ig_comment_id").in("ig_comment_id", mine.map((c) => c.id));
    const have = new Set((existing ?? []).map((r) => (r as { ig_comment_id: string }).ig_comment_id));
    const fresh = mine.filter((c) => !have.has(c.id));
    if (fresh.length > 0) {
      const { error } = await supabase.from("social_comments").insert(fresh.map((c) => ({
        seller_id: SELLER, ig_comment_id: c.id, ig_media_id: c.mediaId, media_permalink: c.permalink, username: c.username,
        comment_text: c.text, commented_at: c.timestamp, status: "NEW"
      })));
      if (error && !/duplicate key/i.test(error.message)) throw new Error(error.message);
    }
  }
  const { data: todo } = await supabase.from("social_comments").select("id,comment_text").eq("seller_id", SELLER).eq("status", "NEW").order("commented_at", { ascending: false }).limit(10);
  let drafted = 0;
  let aiBlocked: string | null = null;
  for (const row of (todo ?? []) as { id: string; comment_text: string }[]) {
    const res = await draftReply(row.comment_text);
    if ("blocked" in res) { aiBlocked = res.blocked; break; }
    await supabase.from("social_comments").update({ suggested_reply: res.reply, status: res.needsOwner ? "NEEDS_OWNER" : "DRAFTED" }).eq("id", row.id);
    drafted += 1;
  }
  const { count } = await supabase.from("social_comments").select("id", { count: "exact", head: true }).eq("status", "NEW");
  return { newComments: Math.max((count ?? 0), 0) + drafted, drafted, aiBlocked };
}

export async function listComments(limit = 30): Promise<CommentRow[]> {
  const { data, error } = await supabase.from("social_comments").select("*").eq("seller_id", SELLER).in("status", ["NEW", "DRAFTED", "NEEDS_OWNER", "REPLIED"]).order("commented_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as CommentRow[];
}

export async function ignoreComment(id: string): Promise<void> {
  const { error } = await supabase.from("social_comments").update({ status: "IGNORED" }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function sendReply(id: string, text: string): Promise<void> {
  const reply = text.trim();
  if (!reply || reply.length > 300) throw new Error("Reply must be 1 to 300 characters.");
  const { data, error } = await supabase.from("social_comments").select("ig_comment_id,status").eq("id", id).maybeSingle();
  if (error || !data) throw new Error("Comment not found.");
  const row = data as { ig_comment_id: string; status: string };
  if (row.status === "REPLIED") throw new Error("Already replied.");
  await replyToInstagramComment(row.ig_comment_id, reply);
  await supabase.from("social_comments").update({ status: "REPLIED", suggested_reply: reply, replied_at: new Date().toISOString() }).eq("id", id);
}
