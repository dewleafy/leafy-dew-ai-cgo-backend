import { createHash } from "crypto";
import { supabase } from "../../db/supabase";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import { ActionLedgerActionType } from "../action-ledger/action-ledger.types";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { generateAiResponse } from "../ai-gateway/ai-gateway.service";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import { getProductImageLookup, lookupProductImage } from "../product-passports/product-passports.service";
import {
  ListingDraftGenerateResult,
  ListingDraftType,
  ListingOptimizationDraftRow,
  SafeListingOptimizationDraft
} from "./listing-drafts.types";

// Safety valve: caps how many real AI provider calls one generateListingDrafts() run will attempt,
// independent of the AI Gateway's own daily/monthly budget guardrails (which still apply per call).
const MAX_AI_CALLS_PER_GENERATION_RUN = 40;

type AiDraftState = { calls: number; limit: number };

type AiDraftType = Extract<
  ListingDraftType,
  "TITLE" | "BULLETS" | "DESCRIPTION" | "BRAND_POSITIONING" | "CUSTOMER_OBJECTIONS" | "PACKAGE_CONTENTS" | "COMPLIANCE_NOTES"
>;

// PACKAGE_CONTENTS and COMPLIANCE_NOTES are extraction-only: the AI is instructed to reply with
// exactly this sentinel when the given facts don't explicitly state an answer, rather than guess.
// Unlike BRAND_POSITIONING/CUSTOMER_OBJECTIONS (internal strategy notes, lower stakes if imprecise),
// these two describe real, factual things about the physical product — inventing a package item or
// a compliance/safety claim that isn't true is a materially different kind of mistake, so this pair
// gets a stricter contract: extract only what's already stated, or say so plainly.
const AI_DRAFT_UNKNOWN_SENTINEL = "UNKNOWN";
const EXTRACTION_ONLY_DRAFT_TYPES: ReadonlySet<AiDraftType> = new Set(["PACKAGE_CONTENTS", "COMPLIANCE_NOTES"]);

// Once the AI has genuinely tried an extraction-only product+type and found nothing explicit to
// extract, that result is recorded as a listing_optimization_drafts row with this status instead of
// "DRAFTED" -- it never shows up in the Listing Drafts list or the Approval Center (see
// listListingDrafts()'s filter below), it exists purely so future generate runs can skip re-asking
// the same already-answered question. Without this, generateListingDrafts() has no memory of a
// UNKNOWN result: the same dead-end products get re-scanned (and re-billed against the per-run AI
// call budget) on every single run forever, starving the budget from ever reaching real candidates
// further down the product list.
const EXTRACTION_ONLY_NO_DATA_STATUS = "NO_DATA";

type ProductContext = {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  title: string | null;
  passport: ProductPassportRow | null;
  listing: AmazonSpListingRow | null;
};

type DraftCandidate = {
  draftType: ListingDraftType;
  currentValue: string | null;
  proposedValue: string | null;
  reason: string;
  confidenceLabel: "LOW" | "MEDIUM" | "HIGH";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  metadata: Record<string, unknown>;
};

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeKey(value: unknown): string | null {
  return cleanText(value)?.toLowerCase() ?? null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayText(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter((item): item is string => Boolean(item))
    : [];
}

function toSafeDraft(row: ListingOptimizationDraftRow): SafeListingOptimizationDraft {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sku: row.sku,
    asin: row.asin,
    productName: row.product_name,
    // Filled in by attachProductImages() after the initial DB row mapping (see below) — left null
    // here since toSafeDraft() only has the raw draft row, not the product image lookup.
    imageUrl: null,
    draftType: row.draft_type,
    currentValue: row.current_value,
    proposedValue: row.proposed_value,
    reason: row.reason,
    source: row.source,
    sourceId: row.source_id,
    actionId: row.action_id,
    status: row.status,
    confidenceLabel: row.confidence_label,
    riskLevel: row.risk_level,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Attaches a real product photo URL to each draft (by SKU, falling back to ASIN) so the Listing
// Drafts page can show what the product actually looks like instead of a generic icon. Built as a
// single bulk lookup per list call rather than one query per row.
async function attachProductImages(rows: SafeListingOptimizationDraft[], sellerId: string): Promise<SafeListingOptimizationDraft[]> {
  if (!rows.length) return rows;

  const lookup = await getProductImageLookup(sellerId);
  return rows.map((row) => ({
    ...row,
    imageUrl: lookupProductImage(lookup, row.sku, row.asin)
  }));
}

function sourceIdForProduct(product: ProductContext, draftType: ListingDraftType): string {
  const key = cleanText(product.sku) ?? cleanText(product.asin) ?? cleanText(product.productName) ?? "account";
  return `listing-draft:${draftType.toLowerCase()}:${key.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.:-]/g, "-")}`;
}

function proposedTitle(product: ProductContext): string | null {
  const name = cleanText(product.productName) ?? cleanText(product.title);
  if (!name) return null;

  const features = arrayText(product.passport?.key_features).slice(0, 2);
  const category = cleanText(product.passport?.category) ?? cleanText(product.passport?.product_type) ?? cleanText(product.listing?.product_type);
  return [name, features.join(" "), category].filter(Boolean).join(" | ").slice(0, 190);
}

function buildProductFactsBlock(product: ProductContext): string {
  const facts: string[] = [];
  const name = cleanText(product.productName) ?? cleanText(product.title);
  if (name) facts.push(`Product name: ${name}`);

  const brand = cleanText(product.passport?.brand);
  if (brand) facts.push(`Brand: ${brand}`);

  const category = cleanText(product.passport?.category) ?? cleanText(product.passport?.product_type) ?? cleanText(product.listing?.product_type);
  if (category) facts.push(`Category: ${category}`);

  const features = arrayText(product.passport?.key_features);
  if (features.length) facts.push(`Known key features: ${features.join("; ")}`);

  const packageContents = cleanText(product.passport?.package_contents);
  if (packageContents) facts.push(`Package contents: ${packageContents}`);

  const targetCustomer = cleanText(product.passport?.target_customer);
  if (targetCustomer) facts.push(`Target customer: ${targetCustomer}`);

  const useCase = cleanText(product.passport?.use_case);
  if (useCase) facts.push(`Use case: ${useCase}`);

  const brandPositioning = cleanText(product.passport?.brand_positioning);
  if (brandPositioning) facts.push(`Brand positioning: ${brandPositioning}`);

  const seoKeywords = arrayText(product.passport?.seo_keywords);
  if (seoKeywords.length) facts.push(`Approved SEO keywords to weave in naturally where relevant: ${seoKeywords.join(", ")}`);

  return facts.join("\n");
}

// A short, stable fingerprint of the exact facts block the AI would see for this product right now.
// Used only to key NO_DATA markers (see EXTRACTION_ONLY_NO_DATA_STATUS above): if a later Amazon
// sync changes this product's known facts (e.g. adds real box-contents wording), the hash changes
// too, so a stale marker stops matching and the product becomes eligible for a fresh AI attempt
// automatically -- no manual cleanup needed.
function factsHashFor(product: ProductContext): string {
  return createHash("sha256").update(buildProductFactsBlock(product)).digest("hex").slice(0, 16);
}

const AI_DRAFT_INSTRUCTIONS: Record<AiDraftType, string> = {
  TITLE:
    'Write ONE Amazon product listing title using only the facts given below. Do not invent specs, certifications, or claims that are not stated. Keep it under 190 characters, no ALL CAPS, no promotional superlatives ("best", "#1", "guaranteed"), no emojis, no HTML. Reply with ONLY the title text and nothing else.',
  BULLETS:
    'Write exactly 5 concise, benefit-led Amazon bullet points using only the facts given below. Do not invent specs, certifications, or claims that are not stated. Each bullet under 200 characters, plain text, no numbering, no bullet characters, no HTML, no emojis. Reply with each bullet on its own line and nothing else.',
  DESCRIPTION:
    'Write an Amazon product description (150 to 250 words) using only the facts given below. Do not invent specs, certifications, or claims that are not stated. Plain text, no HTML, no emojis, no promotional superlatives ("best", "#1", "guaranteed"). Reply with ONLY the description text and nothing else.',
  BRAND_POSITIONING:
    'Write a short internal brand positioning note (2 to 4 sentences) for this product, using only the facts given below. This is an internal strategy note, not customer-facing copy — it explains how this product fits and supports the brand named below (its style, price tier, and the kind of customer it serves). Do not invent specs, certifications, awards, or claims that are not stated. Do not claim this is the "best" or "#1" anything. Plain text, no HTML, no emojis. Reply with ONLY the note and nothing else.',
  CUSTOMER_OBJECTIONS:
    'List 3 to 5 realistic reasons a shopper might hesitate before buying this specific product, using only the facts given below (for example: price relative to what is known, uncertainty about size/fit, durability doubts, or unclear use case) — this is an internal strategy note to help improve the listing later, not customer-facing copy. For each one, write one line as "Objection: <the hesitation> — Address by: <a brief, honest way the listing or brand could address it using only known facts>". Do not invent facts, specs, or certifications to resolve an objection with something not stated. Reply with ONLY the numbered-free list, one objection per line, and nothing else.',
  // Extraction-only, not generation: state what the box contains ONLY if the facts below (most
  // reliably the "Known key features" line, which is this seller's own real, Amazon-synced bullet
  // point text) already say so explicitly. This is a Product Passport field, not customer-facing —
  // but it feeds an internal readiness score, so a wrong answer is still worth avoiding.
  PACKAGE_CONTENTS:
    `State exactly what is included in the product's package/box, using ONLY the facts given below — most reliably the "Known key features" line, which is this seller's own real, already-published Amazon listing text. List each included item as a short phrase, one per line. Do NOT invent, assume, or add any item, accessory, or quantity that is not explicitly and unambiguously stated in the facts below. If the facts below do not clearly and explicitly state what is included in the package, reply with exactly this one word and nothing else: ${AI_DRAFT_UNKNOWN_SENTINEL}. Otherwise reply with ONLY the package contents list and nothing else.`,
  // Extraction-only, deliberately the strictest prompt in this file: compliance/safety/regulatory
  // claims are the one category where a fabricated answer (an invented certification, standard, or
  // age recommendation) is worse than no answer at all, even though this only ever saves to the
  // Product Passport and never touches the live Amazon listing.
  COMPLIANCE_NOTES:
    `State any safety, regulatory, certification, or age-recommendation information for this product, using ONLY what is explicitly and unambiguously stated in the facts given below — most reliably the "Known key features" line, which is this seller's own real, already-published Amazon listing text. Do NOT invent, assume, imply, or add any certification, standard, safety claim, or age recommendation that is not directly and explicitly stated in the facts below — this includes never inventing things like "BIS certified", "CE marked", "food-grade", "non-toxic", or "ASTM compliant" unless those exact words or a clear, unambiguous equivalent already appear in the facts. If the facts below do not explicitly state any compliance, safety, or regulatory information, reply with exactly this one word and nothing else: ${AI_DRAFT_UNKNOWN_SENTINEL}. Otherwise reply with ONLY the compliance notes and nothing else.`
};

const AI_DRAFT_MAX_OUTPUT_TOKENS: Record<AiDraftType, number> = {
  TITLE: 150,
  BULLETS: 300,
  DESCRIPTION: 500,
  BRAND_POSITIONING: 220,
  CUSTOMER_OBJECTIONS: 350,
  PACKAGE_CONTENTS: 150,
  COMPLIANCE_NOTES: 150
};

async function draftValueWithAi(input: {
  product: ProductContext;
  draftType: AiDraftType;
  fallback: string | null;
  aiState: AiDraftState;
}): Promise<{ value: string | null; aiCall: boolean; aiBlockedReason: string | null }> {
  if (input.aiState.calls >= input.aiState.limit) {
    return { value: input.fallback, aiCall: false, aiBlockedReason: "AI_RUN_CALL_LIMIT_REACHED" };
  }

  const facts = buildProductFactsBlock(input.product);
  if (!facts) {
    return { value: input.fallback, aiCall: false, aiBlockedReason: "INSUFFICIENT_PRODUCT_DATA" };
  }

  const prompt = `${AI_DRAFT_INSTRUCTIONS[input.draftType]}\n\nProduct facts:\n${facts}`;

  try {
    const result = await generateAiResponse({
      sellerId: input.product.sellerId,
      moduleName: "LISTING_DRAFTS",
      purpose: `listing_draft_${input.draftType.toLowerCase()}`,
      prompt,
      maxOutputTokens: AI_DRAFT_MAX_OUTPUT_TOKENS[input.draftType],
      requestId: sourceIdForProduct(input.product, input.draftType),
      // generateListingDrafts() only runs from a founder-triggered POST /generate click (no background
      // cron calls it), and the AI Gateway's security guardrail requires a founder/admin actor for any
      // AI_GENERATE call — "system" would be silently blocked here, so this must say "founder".
      actor: "founder",
      metadata: { sku: input.product.sku, asin: input.product.asin, draftType: input.draftType }
    });

    // Only count this against the per-run cap when a real provider call was actually attempted
    // (a success, or a failure that reached the provider) — a local block (disabled/budget/etc.)
    // never touched Anthropic and costs nothing, so it shouldn't eat into the run's call budget.
    if (result.ok || result.blockedReason === "AI_PROVIDER_CALL_FAILED") {
      input.aiState.calls += 1;
    }

    if (result.ok && result.output) {
      const trimmed = result.output.trim();
      // Extraction-only types (PACKAGE_CONTENTS/COMPLIANCE_NOTES) are instructed to reply with the
      // UNKNOWN sentinel rather than guess when the facts don't explicitly support an answer —
      // treat that exactly like "no usable output", not as a real value to save or show a founder.
      if (EXTRACTION_ONLY_DRAFT_TYPES.has(input.draftType) && trimmed.toUpperCase() === AI_DRAFT_UNKNOWN_SENTINEL) {
        return { value: input.fallback, aiCall: true, aiBlockedReason: "AI_COULD_NOT_EXTRACT_FROM_KNOWN_FACTS" };
      }
      return { value: trimmed, aiCall: true, aiBlockedReason: null };
    }

    return { value: input.fallback, aiCall: false, aiBlockedReason: result.blockedReason ?? "AI_CALL_DID_NOT_RETURN_OUTPUT" };
  } catch {
    return { value: input.fallback, aiCall: false, aiBlockedReason: "AI_CALL_ERROR" };
  }
}

async function buildCandidates(
  product: ProductContext,
  aiState: AiDraftState,
  skipTypes: ReadonlySet<ListingDraftType>,
  factsHash: string
): Promise<DraftCandidate[]> {
  const candidates: DraftCandidate[] = [];
  const title = cleanText(product.title);
  const features = arrayText(product.passport?.key_features);
  const seoKeywords = arrayText(product.passport?.seo_keywords);
  const descriptionInputs = [
    cleanText(product.passport?.package_contents),
    cleanText(product.passport?.target_customer),
    cleanText(product.passport?.use_case),
    cleanText(product.passport?.brand_positioning)
  ].filter(Boolean);

  // skipTypes are draft types that already have a pending DRAFTED duplicate for this product,
  // checked up front by the caller — skipping here means never spending a real AI call on a
  // draft that would just be discarded as a duplicate afterward.

  if (!skipTypes.has("TITLE") && (!title || title.length < 40 || title.length > 200)) {
    const ai = await draftValueWithAi({ product, draftType: "TITLE", fallback: proposedTitle(product), aiState });
    candidates.push({
      draftType: "TITLE",
      currentValue: title,
      proposedValue: ai.value,
      reason: !title ? "Listing title is missing." : title.length < 40 ? "Listing title is short and may miss search context." : "Listing title is too long for safe marketplace review.",
      confidenceLabel: ai.aiCall ? "HIGH" : "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { currentLength: title?.length ?? 0, aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason }
    });
  }

  if (!skipTypes.has("BULLETS") && (!features.length || features.length < 3)) {
    const fallback = features.length ? features.join("\n") : "Draft benefit-led bullets from Product Passport key features.";
    const ai = await draftValueWithAi({ product, draftType: "BULLETS", fallback, aiState });
    candidates.push({
      draftType: "BULLETS",
      currentValue: features.join("\n") || null,
      proposedValue: ai.value,
      reason: "Product Passport has fewer than three key feature bullets.",
      confidenceLabel: ai.aiCall ? "HIGH" : "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { featureCount: features.length, aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason }
    });
  }

  if (!skipTypes.has("BACKEND_KEYWORDS") && seoKeywords.length < 5) {
    candidates.push({
      draftType: "BACKEND_KEYWORDS",
      currentValue: seoKeywords.join(", ") || null,
      proposedValue: seoKeywords.length ? seoKeywords.join(", ") : "Collect backend keyword candidates from approved SEO inputs.",
      reason: "Backend keyword inputs are missing or too thin.",
      confidenceLabel: "MEDIUM",
      riskLevel: "LOW",
      metadata: { seoKeywordCount: seoKeywords.length, aiCall: false }
    });
  }

  if (!skipTypes.has("DESCRIPTION") && descriptionInputs.length < 2) {
    const fallback = "Draft description from package contents, target customer, use case, and brand positioning after founder review.";
    const ai = await draftValueWithAi({ product, draftType: "DESCRIPTION", fallback, aiState });
    candidates.push({
      draftType: "DESCRIPTION",
      currentValue: descriptionInputs.join("\n") || null,
      proposedValue: ai.value,
      reason: "Description readiness fields are incomplete in Product Passport.",
      confidenceLabel: ai.aiCall ? "HIGH" : "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { descriptionInputCount: descriptionInputs.length, aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason }
    });
  }

  // These two never go to Amazon — approving one just saves the AI-authored text into the
  // Product Passport (see passport-draft-execution module). They exist specifically because
  // "missing brand positioning" and "missing customer objections" are two of the top gaps the
  // Brand Readiness score surfaces on both brands.
  const brandPositioning = cleanText(product.passport?.brand_positioning);
  if (!skipTypes.has("BRAND_POSITIONING") && !brandPositioning) {
    const ai = await draftValueWithAi({ product, draftType: "BRAND_POSITIONING", fallback: null, aiState });
    if (ai.value) {
      candidates.push({
        draftType: "BRAND_POSITIONING",
        currentValue: brandPositioning,
        proposedValue: ai.value,
        reason: "Brand positioning is missing from this product's Product Passport.",
        confidenceLabel: ai.aiCall ? "HIGH" : "LOW",
        riskLevel: "LOW",
        metadata: { aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason }
      });
    }
  }

  const customerObjections = arrayText(product.passport?.customer_objections);
  if (!skipTypes.has("CUSTOMER_OBJECTIONS") && customerObjections.length < 2) {
    const ai = await draftValueWithAi({ product, draftType: "CUSTOMER_OBJECTIONS", fallback: null, aiState });
    if (ai.value) {
      candidates.push({
        draftType: "CUSTOMER_OBJECTIONS",
        currentValue: customerObjections.length ? customerObjections.join("\n") : null,
        proposedValue: ai.value,
        reason: "Product Passport has fewer than two known customer objections on file.",
        confidenceLabel: ai.aiCall ? "HIGH" : "LOW",
        riskLevel: "LOW",
        metadata: { existingObjectionCount: customerObjections.length, aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason }
      });
    }
  }

  // Also passport-only, also never go to Amazon — but unlike the two above, these describe real
  // facts about the physical product rather than internal marketing strategy, so the AI is run in
  // extraction-only mode (see the PACKAGE_CONTENTS/COMPLIANCE_NOTES prompts above): it may only
  // restate what's already explicitly stated in this product's own known facts, never invent new
  // specifics, and returns nothing (not a candidate) when it can't find a grounded answer.
  const packageContents = cleanText(product.passport?.package_contents);
  if (!skipTypes.has("PACKAGE_CONTENTS") && !packageContents) {
    const ai = await draftValueWithAi({ product, draftType: "PACKAGE_CONTENTS", fallback: null, aiState });
    if (ai.value) {
      candidates.push({
        draftType: "PACKAGE_CONTENTS",
        currentValue: packageContents,
        proposedValue: ai.value,
        reason: "Package contents is missing from this product's Product Passport. Extracted only from this product's own known Amazon listing text — verify before approving.",
        confidenceLabel: ai.aiCall ? "HIGH" : "LOW",
        riskLevel: "LOW",
        metadata: { aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason, extractionOnly: true }
      });
    } else if (ai.aiBlockedReason === "AI_COULD_NOT_EXTRACT_FROM_KNOWN_FACTS") {
      // The AI genuinely ran and found nothing to extract -- record that so future runs stop
      // re-asking this exact product+facts combination (see EXTRACTION_ONLY_NO_DATA_STATUS above).
      await createNoDataMarker(product, "PACKAGE_CONTENTS", factsHash);
    }
  }

  const complianceNotes = cleanText(product.passport?.compliance_notes);
  if (!skipTypes.has("COMPLIANCE_NOTES") && !complianceNotes) {
    const ai = await draftValueWithAi({ product, draftType: "COMPLIANCE_NOTES", fallback: null, aiState });
    if (ai.value) {
      candidates.push({
        draftType: "COMPLIANCE_NOTES",
        currentValue: complianceNotes,
        proposedValue: ai.value,
        reason: "Compliance notes is missing from this product's Product Passport. Extracted only from this product's own known Amazon listing text, never invented — verify before approving.",
        confidenceLabel: ai.aiCall ? "HIGH" : "LOW",
        // Deliberately flagged MEDIUM (not LOW like the other passport-only fields) so this stands
        // out for a closer look in the Approval Center — safety/regulatory claims are the one
        // category here where an approval mistake matters more than a marketing-copy mistake would.
        riskLevel: "MEDIUM",
        metadata: { aiCall: ai.aiCall, aiBlockedReason: ai.aiBlockedReason, extractionOnly: true }
      });
    } else if (ai.aiBlockedReason === "AI_COULD_NOT_EXTRACT_FROM_KNOWN_FACTS") {
      await createNoDataMarker(product, "COMPLIANCE_NOTES", factsHash);
    }
  }

  return candidates;
}

async function loadProductContexts(sellerId: string): Promise<ProductContext[]> {
  const [listingsResult, passportsResult] = await Promise.all([
    supabase
      .from("amazon_sp_listings")
      .select("*")
      .eq("seller_id", sellerId)
      .order("last_synced_at", { ascending: false })
      .limit(500),
    supabase
      .from("product_passports")
      .select("*")
      .eq("seller_id", sellerId)
      .neq("status", "ARCHIVED")
      .order("updated_at", { ascending: false })
      .limit(500)
  ]);

  if (listingsResult.error) throw new Error(listingsResult.error.message);
  if (passportsResult.error) throw new Error(passportsResult.error.message);

  const listings = (listingsResult.data ?? []) as AmazonSpListingRow[];
  const passports = (passportsResult.data ?? []) as ProductPassportRow[];
  const passportBySku = new Map(passports.map((row) => [normalizeKey(row.sku), row]).filter((entry): entry is [string, ProductPassportRow] => Boolean(entry[0])));
  const passportByAsin = new Map(passports.map((row) => [normalizeKey(row.asin), row]).filter((entry): entry is [string, ProductPassportRow] => Boolean(entry[0])));
  const contexts = new Map<string, ProductContext>();

  for (const listing of listings) {
    const skuKey = normalizeKey(listing.sku);
    const asinKey = normalizeKey(listing.asin);
    const key = skuKey ? `sku:${skuKey}` : asinKey ? `asin:${asinKey}` : `listing:${listing.id}`;
    const passport = (skuKey ? passportBySku.get(skuKey) : undefined) ?? (asinKey ? passportByAsin.get(asinKey) : undefined) ?? null;
    contexts.set(key, {
      sellerId,
      sku: cleanText(listing.sku),
      asin: cleanText(listing.asin),
      productName: cleanText(passport?.product_name) ?? cleanText(listing.product_name),
      title: cleanText(listing.product_name),
      passport,
      listing
    });
  }

  for (const passport of passports) {
    const skuKey = normalizeKey(passport.sku);
    const asinKey = normalizeKey(passport.asin);
    const key = skuKey ? `sku:${skuKey}` : asinKey ? `asin:${asinKey}` : `passport:${passport.id}`;
    if (contexts.has(key)) continue;
    contexts.set(key, {
      sellerId,
      sku: cleanText(passport.sku),
      asin: cleanText(passport.asin),
      productName: cleanText(passport.product_name),
      title: cleanText(passport.product_name),
      passport,
      listing: null
    });
  }

  return Array.from(contexts.values());
}

async function draftDuplicateExists(input: {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  draftType: ListingDraftType;
}): Promise<boolean> {
  let query = supabase
    .from("listing_optimization_drafts")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId)
    .eq("draft_type", input.draftType)
    .eq("status", "DRAFTED");

  query = input.sku ? query.eq("sku", input.sku) : query.is("sku", null);
  query = input.asin ? query.eq("asin", input.asin) : query.is("asin", null);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

// See EXTRACTION_ONLY_NO_DATA_STATUS above. Returns true only when a NO_DATA marker exists for this
// exact product+type AND its stored factsHash still matches the facts the product has right now --
// so a stale marker from before the product's data changed never wrongly blocks a fresh AI attempt.
async function extractionOnlyNoDataMarkerMatches(input: {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  draftType: AiDraftType;
  factsHash: string;
}): Promise<boolean> {
  let query = supabase
    .from("listing_optimization_drafts")
    .select("metadata")
    .eq("seller_id", input.sellerId)
    .eq("draft_type", input.draftType)
    .eq("status", EXTRACTION_ONLY_NO_DATA_STATUS)
    .order("created_at", { ascending: false })
    .limit(1);

  query = input.sku ? query.eq("sku", input.sku) : query.is("sku", null);
  query = input.asin ? query.eq("asin", input.asin) : query.is("asin", null);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const row = (data ?? [])[0] as { metadata: Record<string, unknown> | null } | undefined;
  if (!row) return false;

  const storedHash = typeof row.metadata?.factsHash === "string" ? row.metadata.factsHash : null;
  return storedHash === input.factsHash;
}

// Bookkeeping-only insert -- never shown to the founder (listListingDrafts() filters status =
// NO_DATA out) and never gets an action-ledger action. Best-effort: if this insert fails for any
// reason, the product simply gets re-tried on the next run (the old, slower behavior), never a hard
// failure of the real generate run it's called from.
async function createNoDataMarker(product: ProductContext, draftType: AiDraftType, factsHash: string): Promise<void> {
  try {
    await supabase.from("listing_optimization_drafts").insert({
      seller_id: product.sellerId,
      sku: product.sku,
      asin: product.asin,
      product_name: product.productName,
      draft_type: draftType,
      current_value: null,
      proposed_value: null,
      reason: "AI checked this product's known facts and found no explicit answer to extract yet -- not a data quality problem, just nothing stated in the listing text so far.",
      source: "LISTING_DRAFT_SYSTEM",
      source_id: sourceIdForProduct(product, draftType),
      status: EXTRACTION_ONLY_NO_DATA_STATUS,
      confidence_label: "LOW",
      risk_level: "LOW",
      metadata: { noDataMarker: true, extractionOnly: true, factsHash }
    });
  } catch {
    // Intentionally swallowed -- see comment above.
  }
}

async function createDraft(product: ProductContext, candidate: DraftCandidate): Promise<SafeListingOptimizationDraft> {
  const sourceId = sourceIdForProduct(product, candidate.draftType);
  const { data, error } = await supabase
    .from("listing_optimization_drafts")
    .insert({
      seller_id: product.sellerId,
      sku: product.sku,
      asin: product.asin,
      product_name: product.productName,
      draft_type: candidate.draftType,
      current_value: candidate.currentValue,
      proposed_value: candidate.proposedValue,
      reason: candidate.reason,
      source: "LISTING_DRAFT_SYSTEM",
      source_id: sourceId,
      status: "DRAFTED",
      confidence_label: candidate.confidenceLabel,
      risk_level: candidate.riskLevel,
      metadata: {
        shadowMode: true,
        externalExecution: false,
        listingUpdate: false,
        aiCall: false,
        ...candidate.metadata
      }
    })
    .select("*")
    .single<ListingOptimizationDraftRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not create listing draft.");
  return toSafeDraft(data);
}

function actionTypeForDraft(draftType: string): ActionLedgerActionType {
  if (draftType === "TITLE") return "LISTING_TITLE_DRAFT_REVIEW";
  if (draftType === "BULLETS") return "LISTING_BULLETS_DRAFT_REVIEW";
  if (draftType === "BACKEND_KEYWORDS") return "LISTING_BACKEND_KEYWORDS_DRAFT_REVIEW";
  if (draftType === "DESCRIPTION") return "LISTING_DESCRIPTION_DRAFT_REVIEW";
  if (draftType === "BRAND_POSITIONING") return "PASSPORT_BRAND_POSITIONING_DRAFT_REVIEW";
  if (draftType === "CUSTOMER_OBJECTIONS") return "PASSPORT_CUSTOMER_OBJECTIONS_DRAFT_REVIEW";
  if (draftType === "PACKAGE_CONTENTS") return "PASSPORT_PACKAGE_CONTENTS_DRAFT_REVIEW";
  if (draftType === "COMPLIANCE_NOTES") return "PASSPORT_COMPLIANCE_NOTES_DRAFT_REVIEW";
  return "LISTING_READINESS_REVIEW";
}

export async function createActionForListingDraft(draftId: string): Promise<{ row: SafeListingOptimizationDraft; actionCreated: boolean; actionId: string }> {
  const { data: draftRow, error: draftError } = await supabase
    .from("listing_optimization_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle<ListingOptimizationDraftRow>();

  if (draftError) throw new Error(draftError.message);
  if (!draftRow) throw new Error("DRAFT_NOT_FOUND");

  const draft = toSafeDraft(draftRow);
  if (draft.actionId) {
    return { row: draft, actionCreated: false, actionId: draft.actionId };
  }

  const ensured = await ensureActionLedgerAction({
    sellerId: draft.sellerId,
    source: "LISTING_DRAFT_SYSTEM",
    sourceId: draft.sourceId ?? draft.id,
    actionType: actionTypeForDraft(draft.draftType),
    entityType: draft.asin ? "ASIN" : draft.sku ? "SKU" : "ACCOUNT",
    entityId: draft.asin ?? draft.sku ?? draft.id,
    sku: draft.sku,
    asin: draft.asin,
    title: `Review ${draft.draftType.toLowerCase().replace(/_/g, " ")} draft${draft.productName ? ` for ${draft.productName}` : ""}`,
    summary: draft.reason,
    recommendedAction: "REVIEW_LISTING_DRAFT",
    riskLevel: draft.riskLevel as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    confidenceLabel: draft.confidenceLabel as "LOW" | "MEDIUM" | "HIGH",
    approvalTier: "TIER_2",
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      draftId: draft.id,
      draftType: draft.draftType,
      currentValue: draft.currentValue,
      proposedValue: draft.proposedValue,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      source: draft.source,
      sourceId: draft.sourceId,
      reason: draft.reason
    },
    guardrails: {
      shadowMode: true,
      externalExecution: false,
      listingUpdate: false,
      amazonUpdate: false,
      aiCall: false
    }
  });

  const { data: updated, error: updateError } = await supabase
    .from("listing_optimization_drafts")
    .update({ action_id: ensured.row.id, updated_at: new Date().toISOString() })
    .eq("id", draft.id)
    .select("*")
    .single<ListingOptimizationDraftRow>();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Could not update listing draft action id.");

  await recordLearningEventSafe({
    sellerId: draft.sellerId,
    actionId: ensured.row.id,
    source: "LISTING_DRAFT_SYSTEM",
    sourceId: draft.sourceId,
    actionType: ensured.row.actionType,
    entityType: ensured.row.entityType,
    entityId: ensured.row.entityId,
    sku: draft.sku,
    asin: draft.asin,
    eventType: "LISTING_DRAFT_CREATED",
    actor: "system",
    evidence: { draftId: draft.id, draftType: draft.draftType },
    metadata: { listingDraftSystem: true }
  });

  await safeRecordActivityLog({
    sellerId: draft.sellerId,
    eventType: "LISTING_DRAFT_ACTION_CREATED",
    eventCategory: "LISTING_DRAFTS",
    severity: ensured.created ? "INFO" : "WARNING",
    actor: "system",
    title: "Listing draft action linked",
    message: "Listing draft review action was created or linked. No listing update executed.",
    entityType: ensured.row.entityType,
    entityId: ensured.row.entityId,
    sku: draft.sku,
    asin: draft.asin,
    actionId: ensured.row.id,
    sourceModule: "listing-drafts",
    metadata: { draftId: draft.id, actionCreated: ensured.created, listingUpdate: false }
  });

  return { row: toSafeDraft(updated), actionCreated: ensured.created, actionId: ensured.row.id };
}

export async function generateListingDrafts(sellerIdInput: string): Promise<ListingDraftGenerateResult> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const products = await loadProductContexts(sellerId);
  const rows: SafeListingOptimizationDraft[] = [];
  let skippedCount = 0;
  let actionsCreated = 0;
  const aiState: AiDraftState = { calls: 0, limit: MAX_AI_CALLS_PER_GENERATION_RUN };

  const draftTypesToCheck: ListingDraftType[] = [
    "TITLE",
    "BULLETS",
    "BACKEND_KEYWORDS",
    "DESCRIPTION",
    "BRAND_POSITIONING",
    "CUSTOMER_OBJECTIONS",
    "PACKAGE_CONTENTS",
    "COMPLIANCE_NOTES"
  ];

  for (const product of products) {
    // Check for existing pending duplicates BEFORE generating candidates, so we never spend a
    // real AI call drafting content that will just be thrown away as a duplicate below.
    const skipTypes = new Set<ListingDraftType>();
    for (const draftType of draftTypesToCheck) {
      const alreadyPending = await draftDuplicateExists({
        sellerId,
        sku: product.sku,
        asin: product.asin,
        draftType
      });
      if (alreadyPending) skipTypes.add(draftType);
    }

    // Extraction-only types get one more check: a still-matching NO_DATA marker means the AI
    // already tried this exact product with these exact facts and found nothing to extract, so
    // skip it too -- this is what lets the run's limited AI-call budget reach products that
    // haven't been tried yet instead of re-asking the same dead-end question every round.
    const factsHash = factsHashFor(product);
    for (const draftType of EXTRACTION_ONLY_DRAFT_TYPES) {
      if (skipTypes.has(draftType)) continue;
      const noDataMatches = await extractionOnlyNoDataMarkerMatches({
        sellerId,
        sku: product.sku,
        asin: product.asin,
        draftType,
        factsHash
      });
      if (noDataMatches) skipTypes.add(draftType);
    }

    const candidates = await buildCandidates(product, aiState, skipTypes, factsHash);
    if (!candidates.length) {
      skippedCount += skipTypes.size > 0 ? skipTypes.size : 1;
      continue;
    }

    for (const candidate of candidates) {
      // Defense-in-depth: re-check immediately before insert in case a duplicate was created by
      // another process between the up-front check above and now.
      const duplicate = await draftDuplicateExists({
        sellerId,
        sku: product.sku,
        asin: product.asin,
        draftType: candidate.draftType
      });

      if (duplicate) {
        skippedCount += 1;
        continue;
      }

      const draft = await createDraft(product, candidate);
      const actionResult = await createActionForListingDraft(draft.id);
      rows.push(actionResult.row);
      if (actionResult.actionCreated) actionsCreated += 1;
    }
  }

  await safeRecordActivityLog({
    sellerId,
    eventType: "LISTING_DRAFT_GENERATION_COMPLETED",
    eventCategory: "LISTING_DRAFTS",
    severity: rows.length > 0 ? "INFO" : "WARNING",
    actor: "system",
    title: "Listing draft generation completed",
    message: "Listing draft generation completed in shadow mode. No listing update executed.",
    sourceModule: "listing-drafts",
    metadata: { scannedCount: products.length, draftsCreated: rows.length, actionsCreated, skippedCount, aiCallsUsed: aiState.calls, aiCallLimit: aiState.limit }
  });

  return {
    ok: true,
    sellerId,
    scannedCount: products.length,
    draftsCreated: rows.length,
    actionsCreated,
    skippedCount,
    rows
  };
}

export async function listListingDrafts(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeListingOptimizationDraft[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("listing_optimization_drafts")
    .select("*")
    .eq("seller_id", sellerId)
    // NO_DATA rows are internal bookkeeping markers (see EXTRACTION_ONLY_NO_DATA_STATUS above) --
    // they never had real proposed content and never got an approval action, so they're excluded
    // from every founder-facing list/count.
    .neq("status", EXTRACTION_ONLY_NO_DATA_STATUS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as ListingOptimizationDraftRow[]).map(toSafeDraft);
  return attachProductImages(rows, sellerId);
}

// Permanent delete of selected listing_optimization_drafts rows. Unlike the Action Ledger's
// equivalent (batchDeleteActionLedgerRows), this is not restricted to any particular status --
// the founder explicitly wants a full reset available here (including already-approved/sent
// draft records), and this table has no downstream cascade to worry about: action_ledger.payload
// already carries its own snapshot of draftId/currentValue/proposedValue, so deleting a draft row
// never erases what an already-approved or already-executed action actually did.
export async function batchDeleteListingDrafts(input: {
  sellerId: string;
  ids: string[];
}): Promise<{
  sellerId: string;
  requestedCount: number;
  deletedCount: number;
  skippedCount: number;
  rows: SafeListingOptimizationDraft[];
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const requestedCount = input.ids.length;
  const ids = [...new Set(input.ids.map((id) => cleanText(id)).filter((id): id is string => Boolean(id)))];

  if (!ids.length) {
    return { sellerId, requestedCount, deletedCount: 0, skippedCount: requestedCount, rows: [] };
  }

  const { data, error } = await supabase
    .from("listing_optimization_drafts")
    .delete()
    .eq("seller_id", sellerId)
    .in("id", ids)
    .select("*");

  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as ListingOptimizationDraftRow[]).map(toSafeDraft);
  const deletedCount = rows.length;
  const skippedCount = Math.max(requestedCount - deletedCount, 0);

  return { sellerId, requestedCount, deletedCount, skippedCount, rows };
}

async function countDrafts(input: {
  sellerId: string;
  status?: string;
  draftType?: ListingDraftType;
}): Promise<number> {
  let query = supabase
    .from("listing_optimization_drafts")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId);
  if (input.status) {
    query = query.eq("status", input.status);
  } else {
    // Unfiltered counts (e.g. totalDrafts in getListingDraftSummary) should still exclude the
    // internal NO_DATA bookkeeping rows -- a caller explicitly asking for status: "NO_DATA" is
    // unaffected since the branch above already scopes the query in that case.
    query = query.neq("status", EXTRACTION_ONLY_NO_DATA_STATUS);
  }
  if (input.draftType) query = query.eq("draft_type", input.draftType);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function getListingDraftSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalDrafts: number;
  draftedCount: number;
  titleDrafts: number;
  bulletDrafts: number;
  backendKeywordDrafts: number;
  descriptionDrafts: number;
  latestDrafts: SafeListingOptimizationDraft[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [totalDrafts, draftedCount, titleDrafts, bulletDrafts, backendKeywordDrafts, descriptionDrafts, latestDrafts] = await Promise.all([
    countDrafts({ sellerId }),
    countDrafts({ sellerId, status: "DRAFTED" }),
    countDrafts({ sellerId, draftType: "TITLE" }),
    countDrafts({ sellerId, draftType: "BULLETS" }),
    countDrafts({ sellerId, draftType: "BACKEND_KEYWORDS" }),
    countDrafts({ sellerId, draftType: "DESCRIPTION" }),
    listListingDrafts({ sellerId, limit: 10 })
  ]);

  return {
    ok: true,
    sellerId,
    totalDrafts,
    draftedCount,
    titleDrafts,
    bulletDrafts,
    backendKeywordDrafts,
    descriptionDrafts,
    latestDrafts
  };
}
