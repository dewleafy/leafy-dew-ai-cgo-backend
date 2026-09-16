import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { ProductPassportRow } from "../product-passports/product-passports.types";
import {
  BrandReadinessBrandResult,
  BrandReadinessNextBestAction,
  BrandReadinessResponse,
  BrandReadinessSection,
  BrandReadinessStatus
} from "./brand-readiness.types";

// The sync's old hardcoded brand: "Leafy Dew" bug is now fixed at the source (see
// amazon-sp.service.ts's own resolveBrandForListing, plus the one-time SQL backfill for
// rows created before the fix) — but this scorer still detects brand from the SKU/product
// name itself rather than trusting the stored `brand` column, so this score stays correct
// even for any row the backfill or a stale sync hasn't touched yet. Kept in sync with the
// same detection logic used at the sync source.
const KNOWN_SECONDARY_BRANDS: Array<{ match: RegExp; brandName: string }> = [
  { match: /ziro\s*kart/i, brandName: "Ziro kart" }
];
const DEFAULT_BRAND_NAME = "Leafy Dew";

function resolveBrandName(product: ProductPassportRow): string {
  const haystack = `${product.sku ?? ""} ${product.product_name ?? ""}`;

  for (const candidate of KNOWN_SECONDARY_BRANDS) {
    if (candidate.match.test(haystack)) {
      return candidate.brandName;
    }
  }

  return DEFAULT_BRAND_NAME;
}

function groupProductsByBrand(products: ProductPassportRow[]): Map<string, ProductPassportRow[]> {
  const groups = new Map<string, ProductPassportRow[]>();

  for (const product of products) {
    const brandName = resolveBrandName(product);
    groups.set(brandName, [...(groups.get(brandName) ?? []), product]);
  }

  return groups;
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

function logBrandReadinessError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
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

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function percentWith(products: ProductPassportRow[], predicate: (product: ProductPassportRow) => boolean): number {
  if (products.length === 0) {
    return 0;
  }

  return products.filter(predicate).length / products.length;
}

function uniqueValues(values: Array<string | null>): string[] {
  return Array.from(new Set(values.map(normalize).filter(Boolean)));
}

function sectionStatus(score: number): BrandReadinessStatus {
  if (score >= 80) {
    return "STRONG";
  }

  if (score >= 55) {
    return "NEEDS_WORK";
  }

  return "WEAK";
}

function buildSection(score: number, gaps: string[], warnings: string[] = []): BrandReadinessSection {
  const safeScore = Math.min(score, 100);

  return {
    score: safeScore,
    status: sectionStatus(safeScore),
    gaps,
    warnings
  };
}

function scoreBrandConsistency(products: ProductPassportRow[]): BrandReadinessSection {
  let score = 0;
  const gaps: string[] = [];
  const brands = uniqueValues(products.map((product) => product.brand));

  if (products.length > 0) score += 20;
  else gaps.push("Add product passports.");

  if (products.length > 0 && products.every((product) => isPresent(product.brand))) score += 20;
  else gaps.push("Add brand to every product.");

  if (products.length > 0 && brands.length === 1) score += 20;
  else gaps.push("Keep brand name consistent across products.");

  if (products.length > 0 && products.every((product) => isPresent(product.category))) score += 15;
  else gaps.push("Add category to every product.");

  if (products.length > 0 && products.every((product) => isPresent(product.brand_positioning))) score += 25;
  else gaps.push("Add brand positioning to every product.");

  return buildSection(score, gaps);
}

function scoreTrustReadiness(products: ProductPassportRow[]): BrandReadinessSection {
  let score = 0;
  const gaps: string[] = [];

  if (percentWith(products, (product) => isPresent(product.material)) >= 0.8) score += 20;
  else gaps.push("Add material to at least 80% of products.");

  if (percentWith(products, (product) => isPresent(product.package_contents)) >= 0.8) score += 20;
  else gaps.push("Add package contents to at least 80% of products.");

  if (percentWith(products, (product) => asArray(product.customer_objections).length >= 2) >= 0.8) score += 20;
  else gaps.push("Add customer objections to at least 80% of products.");

  if (percentWith(products, (product) => isPresent(product.dimensions)) >= 0.6) score += 15;
  else gaps.push("Add dimensions to at least 60% of products.");

  if (percentWith(products, (product) => isPresent(product.weight)) >= 0.6) score += 10;
  else gaps.push("Add weight to at least 60% of products.");

  if (percentWith(products, (product) => isPresent(product.compliance_notes)) >= 0.5) score += 15;
  else gaps.push("Add compliance notes to at least 50% of products.");

  return buildSection(score, gaps);
}

function scorePremiumFeel(products: ProductPassportRow[]): BrandReadinessSection {
  let score = 0;
  const gaps: string[] = [];

  if (percentWith(products, (product) => asArray(product.image_urls).length >= 3) >= 0.6) score += 25;
  else gaps.push("Add at least 3 images to 60% of products.");

  if (percentWith(products, (product) => isPresent(product.brand_positioning)) >= 0.8) score += 25;
  else gaps.push("Add brand positioning to at least 80% of products.");

  if (percentWith(products, (product) => asArray(product.key_features).length >= 5) >= 0.6) score += 25;
  else gaps.push("Add at least 5 key features to 60% of products.");

  if (percentWith(products, (product) => isPresent(product.material)) >= 0.8) score += 25;
  else gaps.push("Add material to at least 80% of products.");

  return buildSection(score, gaps);
}

function scoreProductRangeClarity(products: ProductPassportRow[]): BrandReadinessSection {
  let score = 0;
  const gaps: string[] = [];
  const categories = uniqueValues(products.map((product) => product.category));
  const productTypes = uniqueValues(products.map((product) => product.product_type));
  const useCases = uniqueValues(products.map((product) => product.use_case));

  if (products.length >= 1) score += 20;
  else gaps.push("Add at least 1 product.");

  if (products.length >= 3) score += 20;
  else gaps.push("Add at least 3 products for a clearer range.");

  if (categories.length >= 1) score += 20;
  else gaps.push("Add at least 1 product category.");

  if (productTypes.length >= 2) score += 20;
  else gaps.push("Add at least 2 product types.");

  if (useCases.length >= 2) score += 20;
  else gaps.push("Add at least 2 use cases.");

  return buildSection(score, gaps);
}

function scoreBundleOpportunity(products: ProductPassportRow[]): BrandReadinessSection {
  if (products.length < 2) {
    return buildSection(20, ["Add at least 2 products for bundles."], ["Add more products to unlock bundle intelligence."]);
  }

  let score = 0;
  const gaps: string[] = [];
  const categories = uniqueValues(products.map((product) => product.category));
  const useCases = uniqueValues(products.map((product) => product.use_case));

  if (products.length >= 2) score += 25;

  if (categories.length === 1 && categories[0]) score += 25;
  else gaps.push("Create products that share a clear bundle category.");

  if (useCases.length >= 2) score += 25;
  else gaps.push("Add complementary use cases.");

  if (products.filter((product) => isPresent(product.selling_price)).length >= 2) score += 25;
  else gaps.push("Add selling price to at least 2 products.");

  return buildSection(score, gaps);
}

function scoreSocialContentOpportunity(products: ProductPassportRow[]): BrandReadinessSection {
  let score = 0;
  const gaps: string[] = [];

  if (percentWith(products, (product) => isPresent(product.use_case)) >= 0.8) score += 25;
  else gaps.push("Add use case to at least 80% of products.");

  if (percentWith(products, (product) => isPresent(product.target_customer)) >= 0.8) score += 25;
  else gaps.push("Add target customer to at least 80% of products.");

  if (percentWith(products, (product) => asArray(product.key_features).length >= 3) >= 0.8) score += 25;
  else gaps.push("Add at least 3 key features to 80% of products.");

  if (percentWith(products, (product) => asArray(product.image_urls).length >= 1) >= 0.6) score += 25;
  else gaps.push("Add at least 1 image to 60% of products.");

  return buildSection(score, gaps);
}

function scoreStoreReadiness(products: ProductPassportRow[]): BrandReadinessSection {
  let score = 0;
  const gaps: string[] = [];
  const categoriesAndTypes = uniqueValues([
    ...products.map((product) => product.category),
    ...products.map((product) => product.product_type)
  ]);

  if (products.length >= 3) score += 25;
  else gaps.push("Add at least 3 products for store readiness.");

  if (percentWith(products, (product) => asArray(product.image_urls).length >= 3) >= 0.6) score += 25;
  else gaps.push("Add at least 3 images to 60% of products.");

  if (percentWith(products, (product) => isPresent(product.brand_positioning)) >= 0.8) score += 25;
  else gaps.push("Add brand positioning to at least 80% of products.");

  if (categoriesAndTypes.length >= 2) score += 25;
  else gaps.push("Add at least 2 categories or product types.");

  return buildSection(score, gaps);
}

function calculateOverallScore(sections: Record<string, BrandReadinessSection>): number {
  return Math.round(
    sections.brandConsistency.score * 0.2 +
      sections.trustReadiness.score * 0.15 +
      sections.premiumFeel.score * 0.15 +
      sections.productRangeClarity.score * 0.15 +
      sections.bundleOpportunity.score * 0.1 +
      sections.socialContentOpportunity.score * 0.15 +
      sections.storeReadiness.score * 0.1
  );
}

function getReadinessStatus(score: number): BrandReadinessStatus {
  if (score >= 80) return "STRONG";
  if (score >= 55) return "NEEDS_WORK";
  return "WEAK";
}

function getTopBrandGaps(sections: Record<string, BrandReadinessSection>): string[] {
  const gaps = Object.values(sections).flatMap((section) => section.gaps);
  return Array.from(new Set(gaps)).slice(0, 8);
}

function getRecommendedActions(input: {
  products: ProductPassportRow[];
  missingBrandPositioningCount: number;
  missingImagesCount: number;
  overallScore: number;
}): string[] {
  const actions: string[] = [];

  if (input.products.length === 0) actions.push("Add product passports for the brand.");
  if (input.missingBrandPositioningCount > 0) actions.push("Add brand positioning to every product passport.");
  if (input.missingImagesCount > 0) actions.push("Add product images to improve brand trust and store readiness.");
  if (input.overallScore < 55) actions.push("Fix core brand gaps before scaling traffic.");
  if (input.overallScore >= 55 && input.overallScore < 80) actions.push("Improve product content consistency across the brand.");

  return actions;
}

function getBundleIdeas(products: ProductPassportRow[]): string[] {
  const categoryMap = new Map<string, ProductPassportRow[]>();

  for (const product of products) {
    const category = normalize(product.category);

    if (!category) {
      continue;
    }

    categoryMap.set(category, [...(categoryMap.get(category) ?? []), product]);
  }

  return Array.from(categoryMap.values())
    .filter((group) => group.length >= 2)
    .slice(0, 5)
    .map((group) => `Bundle ${group.slice(0, 3).map((product) => product.product_name).join(" + ")}.`);
}

function getSocialContentIdeas(products: ProductPassportRow[]): string[] {
  return products
    .filter((product) => isPresent(product.use_case) || asArray(product.key_features).length > 0)
    .slice(0, 5)
    .map((product) => {
      const useCase = product.use_case ? ` for ${product.use_case}` : "";
      return `Create short-form content showing ${product.product_name}${useCase}.`;
    });
}

function getNextBestAction(input: {
  productCount: number;
  missingBrandPositioningCount: number;
  missingImagesCount: number;
  overallScore: number;
}): BrandReadinessNextBestAction {
  if (input.productCount === 0) {
    return {
      title: "Add product passports",
      reason: "Brand readiness needs at least one product passport.",
      priority: "HIGH"
    };
  }

  if (input.missingBrandPositioningCount > 0) {
    return {
      title: "Add brand positioning",
      reason: "Brand positioning is missing on one or more products.",
      priority: "HIGH"
    };
  }

  if (input.missingImagesCount > 0) {
    return {
      title: "Add product images",
      reason: "Images are needed for brand trust and store readiness.",
      priority: "HIGH"
    };
  }

  if (input.overallScore < 55) {
    return {
      title: "Fix core brand gaps",
      reason: "The brand foundation is still weak.",
      priority: "HIGH"
    };
  }

  if (input.overallScore < 80) {
    return {
      title: "Improve brand readiness",
      reason: "The brand has a foundation, but consistency and trust inputs need work.",
      priority: "MEDIUM"
    };
  }

  return {
    title: "Brand foundation is strong",
    reason: "Brand readiness is strong enough for the next controlled growth steps.",
    priority: "LOW"
  };
}

async function loadProductPassports(sellerId: string): Promise<ProductPassportRow[]> {
  const { data, error } = await supabase
    .from("product_passports")
    .select("*")
    .eq("seller_id", sellerId)
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    logBrandReadinessError("Could not load product passports for brand readiness.", error);
    throw new Error("Could not load product passports.");
  }

  return (data ?? []) as ProductPassportRow[];
}

function buildBrandReadinessResult(brandName: string, products: ProductPassportRow[]): BrandReadinessBrandResult {
  const productCount = products.length;
  const activeProductCount = products.filter((product) => product.status === "ACTIVE").length;
  const draftProductCount = products.filter((product) => product.status === "DRAFT").length;
  const missingBrandPositioningCount = products.filter((product) => !isPresent(product.brand_positioning)).length;
  const missingImagesCount = products.filter((product) => asArray(product.image_urls).length === 0).length;
  const bundleIdeas = getBundleIdeas(products);
  const sections = {
    brandConsistency: scoreBrandConsistency(products),
    trustReadiness: scoreTrustReadiness(products),
    premiumFeel: scorePremiumFeel(products),
    productRangeClarity: scoreProductRangeClarity(products),
    bundleOpportunity: scoreBundleOpportunity(products),
    socialContentOpportunity: scoreSocialContentOpportunity(products),
    storeReadiness: scoreStoreReadiness(products)
  };
  const overallScore = calculateOverallScore(sections);
  const warnings = Object.values(sections).flatMap((section) => section.warnings);

  return {
    brandName,
    overallScore,
    readinessStatus: getReadinessStatus(overallScore),
    sections,
    summary: {
      productCount,
      activeProductCount,
      draftProductCount,
      missingBrandPositioningCount,
      missingImagesCount,
      bundleCandidateCount: bundleIdeas.length
    },
    topBrandGaps: getTopBrandGaps(sections),
    recommendedActions: getRecommendedActions({
      products,
      missingBrandPositioningCount,
      missingImagesCount,
      overallScore
    }),
    bundleIdeas,
    socialContentIdeas: getSocialContentIdeas(products),
    nextBestAction: getNextBestAction({
      productCount,
      missingBrandPositioningCount,
      missingImagesCount,
      overallScore
    }),
    warnings
  };
}

export async function getBrandReadiness(sellerId: string): Promise<BrandReadinessResponse> {
  const products = await loadProductPassports(sellerId);
  const groups = groupProductsByBrand(products);

  // Always include the primary brand, even with zero products, so the UI has a stable
  // row to render instead of the whole brand silently disappearing.
  if (!groups.has(DEFAULT_BRAND_NAME)) {
    groups.set(DEFAULT_BRAND_NAME, []);
  }

  const brands = Array.from(groups.entries())
    .map(([brandName, brandProducts]) => buildBrandReadinessResult(brandName, brandProducts))
    .sort((a, b) => (a.brandName === DEFAULT_BRAND_NAME ? -1 : b.brandName === DEFAULT_BRAND_NAME ? 1 : a.brandName.localeCompare(b.brandName)));

  return {
    ok: true,
    sellerId,
    mode: "BRAND_READINESS_V1",
    brands,
    brandDetectionNote:
      "Brand is detected from each product's SKU/name. The product_passports.brand column has also been fixed at the sync source and should now agree with this for every product going forward."
  };
}
