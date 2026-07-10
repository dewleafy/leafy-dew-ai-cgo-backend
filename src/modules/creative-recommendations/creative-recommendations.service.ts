import { supabase } from "../../db/supabase";
import { ensureActionLedgerAction } from "../action-ledger/action-ledger.service";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import { AmazonSpListingRow } from "../amazon-sp/amazon-sp.types";
import { recordLearningEventSafe } from "../learning-loop/learning-loop.service";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import {
  CreativeRecommendationGenerateResult,
  CreativeRecommendationRow,
  CreativeRecommendationType,
  SafeCreativeRecommendation
} from "./creative-recommendations.types";

type ProductContext = {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  passport: ProductPassportRow | null;
  listing: AmazonSpListingRow | null;
};

type RecommendationCandidate = {
  recommendationType: CreativeRecommendationType;
  title: string;
  summary: string;
  recommendedAction: string;
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

function toSafeRecommendation(row: CreativeRecommendationRow): SafeCreativeRecommendation {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sku: row.sku,
    asin: row.asin,
    productName: row.product_name,
    recommendationType: row.recommendation_type,
    title: row.title,
    summary: row.summary,
    recommendedAction: row.recommended_action,
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

function sourceIdForProduct(product: ProductContext, recommendationType: CreativeRecommendationType): string {
  const key = cleanText(product.sku) ?? cleanText(product.asin) ?? cleanText(product.productName) ?? "account";
  return `creative:${recommendationType.toLowerCase()}:${key.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.:-]/g, "-")}`;
}

function productLabel(product: ProductContext): string {
  return product.sku ?? product.productName ?? product.asin ?? "product";
}

function buildCandidates(product: ProductContext): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  const imageUrls = arrayText(product.passport?.image_urls);
  const hasMainImage = Boolean(cleanText(product.listing?.main_image_url) || imageUrls.length > 0);
  const features = arrayText(product.passport?.key_features);
  const hasUseContext = Boolean(cleanText(product.passport?.target_customer) || cleanText(product.passport?.use_case));
  const hasSizeInputs = Boolean(cleanText(product.passport?.dimensions) || cleanText(product.passport?.weight));
  const hasAPlusInputs = Boolean(cleanText(product.passport?.brand_positioning) && features.length >= 3);
  const hasBrandStory = Boolean(cleanText(product.passport?.brand_positioning) || cleanText(product.passport?.brand));
  const label = productLabel(product);

  if (!hasMainImage) {
    candidates.push({
      recommendationType: "MAIN_IMAGE_REVIEW",
      title: `Review main image readiness for ${label}`,
      summary: "No local main image URL or Product Passport image URL is available.",
      recommendedAction: "REVIEW_MAIN_IMAGE",
      confidenceLabel: "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { imageUrlCount: imageUrls.length, listingMainImagePresent: Boolean(product.listing?.main_image_url) }
    });
  }

  if (imageUrls.length < 3 || features.length < 3) {
    candidates.push({
      recommendationType: "INFOGRAPHIC_IMAGE_REVIEW",
      title: `Plan infographic image coverage for ${label}`,
      summary: "Product has limited images or feature inputs for benefit-led creative review.",
      recommendedAction: "REVIEW_INFOGRAPHIC_IMAGE_PLAN",
      confidenceLabel: "MEDIUM",
      riskLevel: "LOW",
      metadata: { imageUrlCount: imageUrls.length, featureCount: features.length }
    });
  }

  if (!hasUseContext) {
    candidates.push({
      recommendationType: "LIFESTYLE_IMAGE_REVIEW",
      title: `Review lifestyle image direction for ${label}`,
      summary: "Target customer or use-case inputs are missing, so lifestyle creative should be reviewed.",
      recommendedAction: "REVIEW_LIFESTYLE_IMAGE_PLAN",
      confidenceLabel: "MEDIUM",
      riskLevel: "LOW",
      metadata: { targetCustomerPresent: Boolean(product.passport?.target_customer), useCasePresent: Boolean(product.passport?.use_case) }
    });
  }

  if (!hasSizeInputs) {
    candidates.push({
      recommendationType: "SIZE_CHART_IMAGE_REVIEW",
      title: `Review size chart need for ${label}`,
      summary: "Dimensions or weight are missing from Product Passport.",
      recommendedAction: "REVIEW_SIZE_CHART_CREATIVE",
      confidenceLabel: "MEDIUM",
      riskLevel: "LOW",
      metadata: { dimensionsPresent: Boolean(product.passport?.dimensions), weightPresent: Boolean(product.passport?.weight) }
    });
  }

  if (!hasAPlusInputs) {
    candidates.push({
      recommendationType: "A_PLUS_CONTENT_REVIEW",
      title: `Review A+ content readiness for ${label}`,
      summary: "A+ readiness is incomplete because brand positioning or feature inputs are thin.",
      recommendedAction: "REVIEW_A_PLUS_CONTENT",
      confidenceLabel: "MEDIUM",
      riskLevel: "MEDIUM",
      metadata: { brandPositioningPresent: Boolean(product.passport?.brand_positioning), featureCount: features.length }
    });
  }

  if (!hasBrandStory) {
    candidates.push({
      recommendationType: "BRAND_STORY_REVIEW",
      title: `Review brand story inputs for ${label}`,
      summary: "Brand story inputs are missing or unknown.",
      recommendedAction: "REVIEW_BRAND_STORY",
      confidenceLabel: "MEDIUM",
      riskLevel: "LOW",
      metadata: { brandPresent: Boolean(product.passport?.brand), brandPositioningPresent: Boolean(product.passport?.brand_positioning) }
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
    contexts.set(key, {
      sellerId,
      sku: cleanText(listing.sku),
      asin: cleanText(listing.asin),
      productName: cleanText(listing.product_name),
      passport: (skuKey ? passportBySku.get(skuKey) : undefined) ?? (asinKey ? passportByAsin.get(asinKey) : undefined) ?? null,
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
      passport,
      listing: null
    });
  }

  return Array.from(contexts.values());
}

async function recommendationDuplicateExists(input: {
  sellerId: string;
  sku: string | null;
  asin: string | null;
  recommendationType: CreativeRecommendationType;
}): Promise<boolean> {
  let query = supabase
    .from("creative_recommendations")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId)
    .eq("recommendation_type", input.recommendationType)
    .eq("status", "DRAFTED");

  query = input.sku ? query.eq("sku", input.sku) : query.is("sku", null);
  query = input.asin ? query.eq("asin", input.asin) : query.is("asin", null);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function createRecommendation(product: ProductContext, candidate: RecommendationCandidate): Promise<SafeCreativeRecommendation> {
  const sourceId = sourceIdForProduct(product, candidate.recommendationType);
  const { data, error } = await supabase
    .from("creative_recommendations")
    .insert({
      seller_id: product.sellerId,
      sku: product.sku,
      asin: product.asin,
      product_name: product.productName,
      recommendation_type: candidate.recommendationType,
      title: candidate.title,
      summary: candidate.summary,
      recommended_action: candidate.recommendedAction,
      source: "CREATIVE_RECOMMENDATION_SYSTEM",
      source_id: sourceId,
      status: "DRAFTED",
      confidence_label: candidate.confidenceLabel,
      risk_level: candidate.riskLevel,
      metadata: {
        ...candidate.metadata,
        shadowMode: true,
        externalExecution: false,
        imageUpload: false,
        aPlusUpload: false,
        aiCall: false
      }
    })
    .select("*")
    .single<CreativeRecommendationRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not create creative recommendation.");
  return toSafeRecommendation(data);
}

function isAPlusRecommendation(type: string): boolean {
  return type === "A_PLUS_CONTENT_REVIEW" || type === "BRAND_STORY_REVIEW";
}

export async function createActionForCreativeRecommendation(id: string): Promise<{ row: SafeCreativeRecommendation; actionCreated: boolean; actionId: string }> {
  const { data: recommendationRow, error: recommendationError } = await supabase
    .from("creative_recommendations")
    .select("*")
    .eq("id", id)
    .maybeSingle<CreativeRecommendationRow>();

  if (recommendationError) throw new Error(recommendationError.message);
  if (!recommendationRow) throw new Error("RECOMMENDATION_NOT_FOUND");

  const recommendation = toSafeRecommendation(recommendationRow);
  if (recommendation.actionId) {
    return { row: recommendation, actionCreated: false, actionId: recommendation.actionId };
  }

  const actionType = isAPlusRecommendation(recommendation.recommendationType) ? "A_PLUS_CONTENT_REVIEW" : "IMAGE_CREATIVE_REVIEW";
  const ensured = await ensureActionLedgerAction({
    sellerId: recommendation.sellerId,
    source: "CREATIVE_RECOMMENDATION_SYSTEM",
    sourceId: recommendation.sourceId ?? recommendation.id,
    actionType,
    entityType: recommendation.asin ? "ASIN" : recommendation.sku ? "SKU" : "ACCOUNT",
    entityId: recommendation.asin ?? recommendation.sku ?? recommendation.id,
    sku: recommendation.sku,
    asin: recommendation.asin,
    title: recommendation.title,
    summary: recommendation.summary,
    recommendedAction: recommendation.recommendedAction,
    riskLevel: recommendation.riskLevel as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    confidenceLabel: recommendation.confidenceLabel as "LOW" | "MEDIUM" | "HIGH",
    approvalTier: "TIER_2",
    requiresApproval: true,
    state: "WAITING_FOR_APPROVAL",
    approvalStatus: "PENDING",
    payload: {
      recommendationId: recommendation.id,
      recommendationType: recommendation.recommendationType,
      shadowMode: true,
      externalExecution: false
    },
    evidence: {
      source: recommendation.source,
      sourceId: recommendation.sourceId,
      summary: recommendation.summary
    },
    guardrails: {
      shadowMode: true,
      externalExecution: false,
      imageUpload: false,
      aPlusUpload: false,
      amazonUpdate: false,
      aiCall: false
    }
  });

  const { data: updated, error: updateError } = await supabase
    .from("creative_recommendations")
    .update({ action_id: ensured.row.id, updated_at: new Date().toISOString() })
    .eq("id", recommendation.id)
    .select("*")
    .single<CreativeRecommendationRow>();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Could not update creative recommendation action id.");

  await recordLearningEventSafe({
    sellerId: recommendation.sellerId,
    actionId: ensured.row.id,
    source: "CREATIVE_RECOMMENDATION_SYSTEM",
    sourceId: recommendation.sourceId,
    actionType: ensured.row.actionType,
    entityType: ensured.row.entityType,
    entityId: ensured.row.entityId,
    sku: recommendation.sku,
    asin: recommendation.asin,
    eventType: "IMAGE_A_PLUS_RECOMMENDATION_CREATED",
    actor: "system",
    evidence: { recommendationId: recommendation.id, recommendationType: recommendation.recommendationType },
    metadata: { creativeRecommendationSystem: true }
  });

  await safeRecordActivityLog({
    sellerId: recommendation.sellerId,
    eventType: "CREATIVE_RECOMMENDATION_ACTION_CREATED",
    eventCategory: "CREATIVE_RECOMMENDATIONS",
    severity: ensured.created ? "INFO" : "WARNING",
    actor: "system",
    title: "Creative recommendation action linked",
    message: "Creative review action was created or linked. No image or A+ upload executed.",
    entityType: ensured.row.entityType,
    entityId: ensured.row.entityId,
    sku: recommendation.sku,
    asin: recommendation.asin,
    actionId: ensured.row.id,
    sourceModule: "creative-recommendations",
    metadata: { recommendationId: recommendation.id, actionCreated: ensured.created, imageUpload: false, aPlusUpload: false }
  });

  return { row: toSafeRecommendation(updated), actionCreated: ensured.created, actionId: ensured.row.id };
}

export async function generateCreativeRecommendations(sellerIdInput: string): Promise<CreativeRecommendationGenerateResult> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const products = await loadProductContexts(sellerId);
  const rows: SafeCreativeRecommendation[] = [];
  let skippedCount = 0;
  let actionsCreated = 0;

  for (const product of products) {
    const candidates = buildCandidates(product);
    if (!candidates.length) {
      skippedCount += 1;
      continue;
    }

    for (const candidate of candidates) {
      const duplicate = await recommendationDuplicateExists({
        sellerId,
        sku: product.sku,
        asin: product.asin,
        recommendationType: candidate.recommendationType
      });

      if (duplicate) {
        skippedCount += 1;
        continue;
      }

      const recommendation = await createRecommendation(product, candidate);
      const actionResult = await createActionForCreativeRecommendation(recommendation.id);
      rows.push(actionResult.row);
      if (actionResult.actionCreated) actionsCreated += 1;
    }
  }

  await safeRecordActivityLog({
    sellerId,
    eventType: "CREATIVE_RECOMMENDATION_GENERATION_COMPLETED",
    eventCategory: "CREATIVE_RECOMMENDATIONS",
    severity: rows.length > 0 ? "INFO" : "WARNING",
    actor: "system",
    title: "Creative recommendation generation completed",
    message: "Creative recommendation generation completed in shadow mode. No image or A+ upload executed.",
    sourceModule: "creative-recommendations",
    metadata: { scannedCount: products.length, recommendationsCreated: rows.length, actionsCreated, skippedCount }
  });

  return {
    ok: true,
    sellerId,
    scannedCount: products.length,
    recommendationsCreated: rows.length,
    actionsCreated,
    skippedCount,
    rows
  };
}

export async function listCreativeRecommendations(input: {
  sellerId: string;
  limit: number;
}): Promise<SafeCreativeRecommendation[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("creative_recommendations")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return ((data ?? []) as CreativeRecommendationRow[]).map(toSafeRecommendation);
}

async function countRecommendations(input: {
  sellerId: string;
  status?: string;
  recommendationType?: CreativeRecommendationType;
}): Promise<number> {
  let query = supabase
    .from("creative_recommendations")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", input.sellerId);
  if (input.status) query = query.eq("status", input.status);
  if (input.recommendationType) query = query.eq("recommendation_type", input.recommendationType);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function getCreativeRecommendationSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  totalRecommendations: number;
  draftedCount: number;
  imageRecommendations: number;
  aPlusRecommendations: number;
  latestRecommendations: SafeCreativeRecommendation[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [
    totalRecommendations,
    draftedCount,
    mainImage,
    infographic,
    lifestyle,
    sizeChart,
    aPlus,
    brandStory,
    latestRecommendations
  ] = await Promise.all([
    countRecommendations({ sellerId }),
    countRecommendations({ sellerId, status: "DRAFTED" }),
    countRecommendations({ sellerId, recommendationType: "MAIN_IMAGE_REVIEW" }),
    countRecommendations({ sellerId, recommendationType: "INFOGRAPHIC_IMAGE_REVIEW" }),
    countRecommendations({ sellerId, recommendationType: "LIFESTYLE_IMAGE_REVIEW" }),
    countRecommendations({ sellerId, recommendationType: "SIZE_CHART_IMAGE_REVIEW" }),
    countRecommendations({ sellerId, recommendationType: "A_PLUS_CONTENT_REVIEW" }),
    countRecommendations({ sellerId, recommendationType: "BRAND_STORY_REVIEW" }),
    listCreativeRecommendations({ sellerId, limit: 10 })
  ]);

  return {
    ok: true,
    sellerId,
    totalRecommendations,
    draftedCount,
    imageRecommendations: mainImage + infographic + lifestyle + sizeChart,
    aPlusRecommendations: aPlus + brandStory,
    latestRecommendations
  };
}
