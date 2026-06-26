import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { ProductProfitStatus } from "../product-economics/product-economics.types";
import { getProductPassportReadinessById } from "../product-passports/product-passports-readiness.service";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import {
  ListingReadinessPriority,
  ListingReadinessRow,
  ListingReadinessSection,
  ListingReadinessStatus
} from "./listing-readiness.types";

type ProductPassportReadiness = NonNullable<Awaited<ReturnType<typeof getProductPassportReadinessById>>>;

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isPresent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value !== null && value !== undefined;
}

function asArray(value: unknown[] | null): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sanitizeErrorMessage(message: string): string {
  const secretValues = [
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.AMAZON_LWA_CLIENT_SECRET,
    env.AMAZON_ADS_CLIENT_SECRET,
    env.ENCRYPTION_KEY,
    env.CRON_SECRET
  ].filter((value): value is string => Boolean(value));

  return secretValues.reduce(
    (safeMessage, secretValue) => safeMessage.replaceAll(secretValue, "[REDACTED]"),
    message
  );
}

function logListingReadinessError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function sectionStatus(score: number): ListingReadinessStatus {
  if (score >= 80) {
    return "READY";
  }

  if (score >= 55) {
    return "NEEDS_FIX";
  }

  return "POOR";
}

function buildSection(score: number, missingItems: string[], warnings: string[] = []): ListingReadinessSection {
  return {
    score: Math.min(score, 100),
    status: sectionStatus(Math.min(score, 100)),
    missingItems,
    warnings
  };
}

function scoreTitleReadiness(product: ProductPassportRow): ListingReadinessSection {
  let score = 0;
  const missingItems: string[] = [];

  if (isPresent(product.product_name)) score += 30;
  else missingItems.push("product_name");

  if (isPresent(product.brand)) score += 10;
  else missingItems.push("brand");

  if (isPresent(product.category) || isPresent(product.product_type)) score += 15;
  else missingItems.push("category_or_product_type");

  if (isPresent(product.material)) score += 15;
  else missingItems.push("material");

  if (isPresent(product.use_case)) score += 15;
  else missingItems.push("use_case");

  if (isPresent(product.color)) score += 5;
  else missingItems.push("color");

  const titleLength = product.product_name?.trim().length ?? 0;
  if (titleLength >= 20 && titleLength <= 160) score += 10;
  else missingItems.push("product_name_length_20_to_160_chars");

  return buildSection(score, missingItems);
}

function scoreBulletReadiness(product: ProductPassportRow): ListingReadinessSection {
  let score = 0;
  const missingItems: string[] = [];
  const keyFeatures = asArray(product.key_features);
  const customerObjections = asArray(product.customer_objections);

  if (keyFeatures.length >= 3) score += 40;
  else missingItems.push("at_least_3_key_features");

  if (keyFeatures.length >= 5) score += 20;
  else missingItems.push("at_least_5_key_features");

  if (customerObjections.length >= 2) score += 25;
  else missingItems.push("at_least_2_customer_objections");

  if (isPresent(product.use_case)) score += 10;
  else missingItems.push("use_case");

  if (isPresent(product.package_contents)) score += 5;
  else missingItems.push("package_contents");

  return buildSection(score, missingItems);
}

function scoreImageReadiness(product: ProductPassportRow): ListingReadinessSection {
  let score = 0;
  const missingItems: string[] = [];
  const warnings: string[] = [];
  const imageUrls = asArray(product.image_urls);

  if (imageUrls.length >= 1) score += 25;
  else {
    missingItems.push("at_least_1_image_url");
    warnings.push("Add product images before final listing review.");
  }

  if (imageUrls.length >= 3) score += 25;
  else missingItems.push("at_least_3_image_urls");

  if (imageUrls.length >= 5) score += 25;
  else missingItems.push("at_least_5_image_urls");

  if (isPresent(product.dimensions) || isPresent(product.package_contents)) score += 10;
  else missingItems.push("dimensions_or_package_contents");

  if (isPresent(product.material)) score += 15;
  else missingItems.push("material");

  return buildSection(score, missingItems, warnings);
}

function scoreSeoReadiness(product: ProductPassportRow): ListingReadinessSection {
  let score = 0;
  const missingItems: string[] = [];
  const seoKeywords = asArray(product.seo_keywords);

  if (seoKeywords.length >= 5) score += 40;
  else missingItems.push("at_least_5_seo_keywords");

  if (seoKeywords.length >= 10) score += 20;
  else missingItems.push("at_least_10_seo_keywords");

  if (isPresent(product.category)) score += 10;
  else missingItems.push("category");

  if (isPresent(product.product_type)) score += 10;
  else missingItems.push("product_type");

  if (isPresent(product.use_case)) score += 10;
  else missingItems.push("use_case");

  if (isPresent(product.target_customer)) score += 10;
  else missingItems.push("target_customer");

  return buildSection(score, missingItems);
}

function scoreTrustReadiness(product: ProductPassportRow): ListingReadinessSection {
  let score = 0;
  const missingItems: string[] = [];

  if (isPresent(product.material)) score += 20;
  else missingItems.push("material");

  if (isPresent(product.dimensions)) score += 15;
  else missingItems.push("dimensions");

  if (isPresent(product.weight)) score += 10;
  else missingItems.push("weight");

  if (isPresent(product.package_contents)) score += 20;
  else missingItems.push("package_contents");

  if (asArray(product.customer_objections).length >= 2) score += 20;
  else missingItems.push("at_least_2_customer_objections");

  if (isPresent(product.compliance_notes)) score += 15;
  else missingItems.push("compliance_notes");

  return buildSection(score, missingItems);
}

function scoreProfitReadiness(readiness: ProductPassportReadiness | null): ListingReadinessSection {
  const profitStatus = readiness?.profitGuardrail.profitStatus ?? "UNKNOWN";

  if (profitStatus === "PASS") return buildSection(100, []);
  if (profitStatus === "RISK") return buildSection(60, ["improve_profit_guardrail"]);
  if (profitStatus === "FAIL") return buildSection(20, ["fix_product_economics"], ["Fix product economics before scaling ads."]);

  return buildSection(0, ["product_economics"], ["Product economics are missing or incomplete."]);
}

function scorePpcReadiness(readiness: ProductPassportReadiness | null): ListingReadinessSection {
  const adStatus = readiness?.adReadiness.status ?? "UNKNOWN";

  if (adStatus === "READY") return buildSection(100, []);
  if (adStatus === "NEEDS_FIX") return buildSection(50, readiness?.adReadiness.missingBeforeAds ?? ["ppc_readiness_inputs"]);
  if (adStatus === "DO_NOT_SCALE") return buildSection(0, ["profit_guardrail"], ["Do not scale ads until product readiness is fixed."]);

  return buildSection(0, ["product_passport_readiness"]);
}

function calculateOverallScore(sections: Record<string, ListingReadinessSection>): number {
  return Math.round(
    sections.titleReadiness.score * 0.15 +
      sections.bulletReadiness.score * 0.15 +
      sections.imageReadiness.score * 0.15 +
      sections.seoReadiness.score * 0.15 +
      sections.trustReadiness.score * 0.15 +
      sections.profitReadiness.score * 0.15 +
      sections.ppcReadiness.score * 0.10
  );
}

function getReadinessStatus(overallScore: number, profitStatus: ProductProfitStatus): ListingReadinessStatus {
  if (overallScore >= 80 && profitStatus === "PASS") {
    return "READY";
  }

  if (overallScore >= 55) {
    return "NEEDS_FIX";
  }

  return "POOR";
}

function getTopMissingItems(sections: Record<string, ListingReadinessSection>): string[] {
  const items = Object.values(sections).flatMap((section) => section.missingItems);
  return Array.from(new Set(items)).slice(0, 8);
}

function getRecommendedFixes(input: {
  sections: Record<string, ListingReadinessSection>;
  profitStatus: ProductProfitStatus;
}): string[] {
  const fixes: string[] = [];

  if (input.sections.seoReadiness.score < 60) fixes.push("Add at least 5 SEO keywords.");
  if (input.sections.imageReadiness.score < 50) fixes.push("Add product images before final listing review.");
  if (input.sections.trustReadiness.missingItems.includes("dimensions") || input.sections.trustReadiness.missingItems.includes("weight")) {
    fixes.push("Add dimensions and weight to reduce buyer confusion.");
  }
  if (input.sections.bulletReadiness.score < 60) fixes.push("Add more key features for bullet generation.");
  if (input.profitStatus === "FAIL" || input.profitStatus === "UNKNOWN") fixes.push("Fix product economics before scaling ads.");

  return Array.from(new Set(fixes));
}

function getNextBestAction(input: {
  overallScore: number;
  profitStatus: ProductProfitStatus;
  sections: Record<string, ListingReadinessSection>;
}): { title: string; reason: string; priority: ListingReadinessPriority } {
  if (input.profitStatus === "FAIL" || input.profitStatus === "UNKNOWN") {
    return {
      title: "Fix product economics first",
      reason: "Profit data must be ready before controlled PPC decisions.",
      priority: "HIGH"
    };
  }

  if (input.sections.imageReadiness.score < 50) {
    return {
      title: "Add listing images",
      reason: "Images are too incomplete for final listing review.",
      priority: "HIGH"
    };
  }

  if (input.sections.seoReadiness.score < 50) {
    return {
      title: "Add SEO keywords",
      reason: "SEO inputs are too thin for listing optimization.",
      priority: "MEDIUM"
    };
  }

  if (input.sections.bulletReadiness.score < 60) {
    return {
      title: "Improve listing bullet inputs",
      reason: "More key features and objections will improve bullet generation.",
      priority: "MEDIUM"
    };
  }

  if (input.overallScore >= 80) {
    return {
      title: "Listing is ready for controlled PPC",
      reason: "Listing inputs and profit guardrail are ready for approval-first PPC.",
      priority: "LOW"
    };
  }

  return {
    title: "Complete listing readiness gaps",
    reason: "A few listing inputs still need cleanup before scaling.",
    priority: "MEDIUM"
  };
}

async function loadProductPassportById(id: string): Promise<ProductPassportRow | null> {
  const { data, error } = await supabase
    .from("product_passports")
    .select("*")
    .eq("id", id)
    .maybeSingle<ProductPassportRow>();

  if (error) {
    logListingReadinessError("Could not load product passport for listing readiness.", error);
    throw new Error("Could not load product passport.");
  }

  return data;
}

async function loadProductPassportsForSeller(sellerId: string): Promise<ProductPassportRow[]> {
  const { data, error } = await supabase
    .from("product_passports")
    .select("*")
    .eq("seller_id", sellerId)
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    logListingReadinessError("Could not load product passports for listing readiness.", error);
    throw new Error("Could not load product passports.");
  }

  return (data ?? []) as ProductPassportRow[];
}

async function buildListingReadiness(product: ProductPassportRow) {
  const productReadiness = await getProductPassportReadinessById(product.id);
  const sections = {
    titleReadiness: scoreTitleReadiness(product),
    bulletReadiness: scoreBulletReadiness(product),
    imageReadiness: scoreImageReadiness(product),
    seoReadiness: scoreSeoReadiness(product),
    trustReadiness: scoreTrustReadiness(product),
    profitReadiness: scoreProfitReadiness(productReadiness),
    ppcReadiness: scorePpcReadiness(productReadiness)
  };
  const overallScore = calculateOverallScore(sections);
  const profitStatus = productReadiness?.profitGuardrail.profitStatus ?? "UNKNOWN";
  const readinessStatus = getReadinessStatus(overallScore, profitStatus);
  const topMissingItems = getTopMissingItems(sections);
  const recommendedFixes = getRecommendedFixes({ sections, profitStatus });
  const nextBestAction = getNextBestAction({ overallScore, profitStatus, sections });
  const warnings = Object.values(sections).flatMap((section) => section.warnings);

  return {
    ok: true,
    productPassportId: product.id,
    sellerId: product.seller_id,
    productName: product.product_name,
    overallScore,
    readinessStatus,
    sections,
    topMissingItems,
    recommendedFixes,
    nextBestAction,
    warnings,
    profitStatus
  };
}

export async function getListingReadinessByProductPassportId(productPassportId: string) {
  const product = await loadProductPassportById(productPassportId);

  if (!product) {
    return null;
  }

  return buildListingReadiness(product);
}

export async function getListingReadinessSummary(sellerId: string) {
  const products = await loadProductPassportsForSeller(sellerId);
  const detailedRows = await Promise.all(products.map((product) => buildListingReadiness(product)));
  const rows: ListingReadinessRow[] = detailedRows.map((readiness) => ({
    productPassportId: readiness.productPassportId,
    sku: products.find((product) => product.id === readiness.productPassportId)?.sku ?? null,
    asin: products.find((product) => product.id === readiness.productPassportId)?.asin ?? null,
    productName: readiness.productName,
    category: products.find((product) => product.id === readiness.productPassportId)?.category ?? null,
    status: products.find((product) => product.id === readiness.productPassportId)?.status ?? "",
    overallScore: readiness.overallScore,
    readinessStatus: readiness.readinessStatus,
    profitStatus: readiness.profitStatus,
    topMissingItems: readiness.topMissingItems,
    nextBestAction: readiness.nextBestAction.title
  }));

  return {
    ok: true,
    sellerId,
    count: rows.length,
    summary: {
      readyCount: rows.filter((row) => row.readinessStatus === "READY").length,
      needsFixCount: rows.filter((row) => row.readinessStatus === "NEEDS_FIX").length,
      poorCount: rows.filter((row) => row.readinessStatus === "POOR").length
    },
    rows
  };
}
