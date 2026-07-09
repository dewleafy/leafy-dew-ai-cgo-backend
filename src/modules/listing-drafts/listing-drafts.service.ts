import { supabase } from "../../db/supabase";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import { ActionLedgerActionType } from "../action-ledger/action-ledger.types";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import {
  ListingDraftGenerateResult,
  ListingDraftType,
  ListingOptimizationDraftRow,
  SafeListingOptimizationDraft
} from "./listing-drafts.types";

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

function buildCandidates(product: ProductContext): DraftCandidate[] {
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

  if (!title || title.length < 40 || title.length > 200) {
    candidates.push({
      draftType: "TITLE",
      currentValue: title,
      proposedValue: proposedTitle(product),
      reason: !title ? "Listing title is missing." : title.length < 40 ? "Listing title is short and may miss search context." : "Listing title is too long for safe marketplace review.",
      confidenceLabel: "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { currentLength: title?.length ?? 0 }
    });
  }

  if (!features.length || features.length < 3) {
    candidates.push({
      draftType: "BULLETS",
      currentValue: features.join("\n") || null,
      proposedValue: features.length ? features.join("\n") : "Draft benefit-led bullets from Product Passport key features.",
      reason: "Product Passport has fewer than three key feature bullets.",
      confidenceLabel: "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { featureCount: features.length }
    });
  }

  if (seoKeywords.length < 5) {
    candidates.push({
      draftType: "BACKEND_KEYWORDS",
      currentValue: seoKeywords.join(", ") || null,
      proposedValue: seoKeywords.length ? seoKeywords.join(", ") : "Collect backend keyword candidates from approved SEO inputs.",
      reason: "Backend keyword inputs are missing or too thin.",
      confidenceLabel: "MEDIUM",
      riskLevel: "LOW",
      metadata: { seoKeywordCount: seoKeywords.length }
    });
  }

  if (descriptionInputs.length < 2) {
    candidates.push({
      draftType: "DESCRIPTION",
      currentValue: descriptionInputs.join("\n") || null,
      proposedValue: "Draft description from package contents, target customer, use case, and brand positioning after founder review.",
      reason: "Description readiness fields are incomplete in Product Passport.",
      confidenceLabel: "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { descriptionInputCount: descriptionInputs.length }
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
        ...candidate.metadata,
        shadowMode: true,
        externalExecution: false,
        listingUpdate: false,
        aiCall: false
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

  return { row: toSafeDraft(updated), actionCreated: ensured.created, actionId: ensured.row.id };
}

export async function generateListingDrafts(sellerIdInput: string): Promise<ListingDraftGenerateResult> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const products = await loadProductContexts(sellerId);
  const rows: SafeListingOptimizationDraft[] = [];
  let skippedCount = 0;
  let actionsCreated = 0;

  for (const product of products) {
    const candidates = buildCandidates(product);
    if (!candidates.length) {
      skippedCount += 1;
      continue;
    }

    for (const candidate of candidates) {
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
