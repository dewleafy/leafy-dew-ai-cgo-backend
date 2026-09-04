import { supabase } from "../../db/supabase";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import { ActionLedgerActionType } from "../action-ledger/action-ledger.types";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { generateAiResponse } from "../ai-gateway/ai-gateway.service";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { ProductPassportRow } from "../product-passports/product-passports.types";
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

type AiDraftType = Extract<ListingDraftType, "TITLE" | "BULLETS" | "DESCRIPTION">;

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

const AI_DRAFT_INSTRUCTIONS: Record<AiDraftType, string> = {
  TITLE:
    'Write ONE Amazon product listing title using only the facts given below. Do not invent specs, certifications, or claims that are not stated. Keep it under 190 characters, no ALL CAPS, no promotional superlatives ("best", "#1", "guaranteed"), no emojis, no HTML. Reply with ONLY the title text and nothing else.',
  BULLETS:
    'Write exactly 5 concise, benefit-led Amazon bullet points using only the facts given below. Do not invent specs, certifications, or claims that are not stated. Each bullet under 200 characters, plain text, no numbering, no bullet characters, no HTML, no emojis. Reply with each bullet on its own line and nothing else.',
  DESCRIPTION:
    'Write an Amazon product description (150 to 250 words) using only the facts given below. Do not invent specs, certifications, or claims that are not stated. Plain text, no HTML, no emojis, no promotional superlatives ("best", "#1", "guaranteed"). Reply with ONLY the description text and nothing else.'
};

const AI_DRAFT_MAX_OUTPUT_TOKENS: Record<AiDraftType, number> = {
  TITLE: 150,
  BULLETS: 300,
  DESCRIPTION: 500
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
      return { value: result.output.trim(), aiCall: true, aiBlockedReason: null };
    }

    return { value: input.fallback, aiCall: false, aiBlockedReason: result.blockedReason ?? "AI_CALL_DID_NOT_RETURN_OUTPUT" };
  } catch {
    return { value: input.fallback, aiCall: false, aiBlockedReason: "AI_CALL_ERROR" };
  }
}

async function buildCandidates(
  product: ProductContext,
  aiState: AiDraftState,
  skipTypes: ReadonlySet<ListingDraftType>
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

  const draftTypesToCheck: ListingDraftType[] = ["TITLE", "BULLETS", "BACKEND_KEYWORDS", "DESCRIPTION"];

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

    const candidates = await buildCandidates(product, aiState, skipTypes);
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
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return ((data ?? []) as ListingOptimizationDraftRow[]).map(toSafeDraft);
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
  if (input.status) query = query.eq("status", input.status);
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
