import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import {
  buildProductEconomicsExplanation,
  toSafeProductEconomicsRow
} from "../product-economics/product-economics.service";
import { ProductEconomicsRow, ProductProfitStatus } from "../product-economics/product-economics.types";
import { ProductPassportRow } from "./product-passports.types";

type CompletenessStatus = "GOOD" | "NEEDS_REVIEW" | "POOR";
type EconomicsLinkStatus = "LINKED" | "MISSING";
type EconomicsMatchType = "ASIN" | "SKU" | "PRODUCT_NAME" | "NONE";
type ProfitDataStatus = "AVAILABLE" | "MISSING";
type AdReadinessStatus = "READY" | "NEEDS_FIX" | "DO_NOT_SCALE";
type Priority = "LOW" | "MEDIUM" | "HIGH";

type ProductEconomicsMatch = {
  status: EconomicsLinkStatus;
  matchType: EconomicsMatchType;
  row: ProductEconomicsRow | null;
};

type PassportCompleteness = {
  score: number;
  status: CompletenessStatus;
  missingFields: string[];
};

type ProductReadiness = {
  ok: true;
  productPassportId: string;
  sellerId: string;
  product: {
    id: string;
    sku: string | null;
    asin: string | null;
    productName: string;
    brand: string | null;
    category: string | null;
    status: string;
  };
  passportCompleteness: PassportCompleteness;
  economicsLink: {
    status: EconomicsLinkStatus;
    matchType: EconomicsMatchType;
    economicsId: string | null;
  };
  profitGuardrail: {
    profitDataStatus: ProfitDataStatus;
    sellingPrice: number | null;
    targetProfit: number | null;
    nonAdCost: number | null;
    maxAllowableAdSpend: number | null;
    targetAcos: number | null;
    breakEvenAcos: number | null;
    profitStatus: ProductProfitStatus;
    reason: string;
  };
  adReadiness: {
    status: AdReadinessStatus;
    reason: string;
    missingBeforeAds: string[];
  };
  nextBestAction: {
    title: string;
    reason: string;
    priority: Priority;
  };
  warnings: string[];
};

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
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

function logReadinessError(context: string, error: { message?: string; code?: string }): void {
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

function calculatePassportCompleteness(product: ProductPassportRow): PassportCompleteness {
  const requiredFields: Array<{ label: string; value: unknown }> = [
    { label: "product_name", value: product.product_name },
    { label: "category", value: product.category },
    { label: "product_type", value: product.product_type },
    { label: "selling_price", value: product.selling_price },
    { label: "target_customer", value: product.target_customer },
    { label: "use_case", value: product.use_case },
    { label: "material", value: product.material },
    { label: "package_contents", value: product.package_contents },
    { label: "key_features", value: product.key_features },
    { label: "customer_objections", value: product.customer_objections },
    { label: "brand_positioning", value: product.brand_positioning }
  ];
  const missingFields = requiredFields
    .filter((field) => !isPresent(field.value))
    .map((field) => field.label);
  const presentCount = requiredFields.length - missingFields.length;
  const score = Math.round((presentCount / requiredFields.length) * 100);
  const status: CompletenessStatus = score >= 80 ? "GOOD" : score >= 50 ? "NEEDS_REVIEW" : "POOR";

  return {
    score,
    status,
    missingFields
  };
}

function matchEconomics(product: ProductPassportRow, economicsRows: ProductEconomicsRow[]): ProductEconomicsMatch {
  if (product.asin) {
    const asinMatch = economicsRows.find(
      (row) => row.asin && normalizeText(row.asin) === normalizeText(product.asin)
    );

    if (asinMatch) {
      return { status: "LINKED", matchType: "ASIN", row: asinMatch };
    }
  }

  if (product.sku) {
    const skuMatch = economicsRows.find(
      (row) => row.sku && normalizeText(row.sku) === normalizeText(product.sku)
    );

    if (skuMatch) {
      return { status: "LINKED", matchType: "SKU", row: skuMatch };
    }
  }

  const productNameMatch = economicsRows.find(
    (row) => normalizeText(row.product_name) === normalizeText(product.product_name)
  );

  if (productNameMatch) {
    return { status: "LINKED", matchType: "PRODUCT_NAME", row: productNameMatch };
  }

  return { status: "MISSING", matchType: "NONE", row: null };
}

function buildProfitGuardrail(economics: ProductEconomicsRow | null): ProductReadiness["profitGuardrail"] {
  if (!economics) {
    return {
      profitDataStatus: "MISSING",
      sellingPrice: null,
      targetProfit: null,
      nonAdCost: null,
      maxAllowableAdSpend: null,
      targetAcos: null,
      breakEvenAcos: null,
      profitStatus: "UNKNOWN",
      reason: "Product economics are missing. Add cost and profit data before scaling ads."
    };
  }

  const safeEconomics = toSafeProductEconomicsRow(economics);
  const explanation = buildProductEconomicsExplanation(safeEconomics);

  return {
    profitDataStatus: "AVAILABLE",
    sellingPrice: safeEconomics.sellingPrice,
    targetProfit: explanation.targetProfit,
    nonAdCost: explanation.nonAdCost,
    maxAllowableAdSpend: explanation.maxAllowableAdSpend,
    targetAcos: explanation.targetAcos,
    breakEvenAcos: explanation.breakEvenAcos,
    profitStatus: explanation.profitStatus,
    reason: explanation.reason
  };
}

function buildAdReadiness(input: {
  completeness: PassportCompleteness;
  economics: ProductEconomicsRow | null;
  profitStatus: ProductProfitStatus;
}): ProductReadiness["adReadiness"] {
  const missingBeforeAds = [...input.completeness.missingFields];

  if (!input.economics) {
    missingBeforeAds.push("product_economics");
  }

  if (input.completeness.status === "POOR") {
    return {
      status: "NEEDS_FIX",
      reason: "Product passport is incomplete.",
      missingBeforeAds
    };
  }

  if (!input.economics) {
    return {
      status: "NEEDS_FIX",
      reason: "Product economics are missing.",
      missingBeforeAds
    };
  }

  if (input.profitStatus === "FAIL") {
    return {
      status: "DO_NOT_SCALE",
      reason: "Profit guardrail is failing.",
      missingBeforeAds
    };
  }

  if (input.profitStatus === "RISK") {
    return {
      status: "NEEDS_FIX",
      reason: "Profit guardrail is risky.",
      missingBeforeAds
    };
  }

  if (input.profitStatus === "PASS" && input.completeness.score >= 80) {
    return {
      status: "READY",
      reason: "Product has enough passport and profit data for controlled PPC decisions.",
      missingBeforeAds
    };
  }

  return {
    status: "NEEDS_FIX",
    reason: "Product needs more details before scaling.",
    missingBeforeAds
  };
}

function buildNextBestAction(input: {
  economics: ProductEconomicsRow | null;
  completeness: PassportCompleteness;
  profitStatus: ProductProfitStatus;
  adReadinessStatus: AdReadinessStatus;
}): ProductReadiness["nextBestAction"] {
  if (!input.economics) {
    return {
      title: "Add product economics",
      reason: "Cost and profit data are required before scaling ads.",
      priority: "HIGH"
    };
  }

  if (input.completeness.score < 80) {
    return {
      title: "Complete product passport",
      reason: "Product details are missing from the passport.",
      priority: "MEDIUM"
    };
  }

  if (input.profitStatus === "FAIL") {
    return {
      title: "Fix price or cost before ads",
      reason: "Profit guardrail is failing.",
      priority: "HIGH"
    };
  }

  if (input.adReadinessStatus === "READY") {
    return {
      title: "Product ready for controlled PPC decisions",
      reason: "Passport and profit guardrail data are ready for approval-first PPC decisions.",
      priority: "LOW"
    };
  }

  return {
    title: "Review product readiness",
    reason: "Product needs review before scaling.",
    priority: "MEDIUM"
  };
}

function buildWarnings(input: {
  completeness: PassportCompleteness;
  economics: ProductEconomicsRow | null;
  profitStatus: ProductProfitStatus;
}): string[] {
  const warnings: string[] = [];

  if (input.completeness.status !== "GOOD") {
    warnings.push("Product passport is missing important fields.");
  }

  if (!input.economics) {
    warnings.push("Product economics are missing.");
  }

  if (input.profitStatus === "FAIL") {
    warnings.push("Profit guardrail is failing. Do not scale ads.");
  }

  return warnings;
}

async function loadProductPassportById(id: string): Promise<ProductPassportRow | null> {
  const { data, error } = await supabase
    .from("product_passports")
    .select("*")
    .eq("id", id)
    .maybeSingle<ProductPassportRow>();

  if (error) {
    logReadinessError("Could not load product passport readiness row.", error);
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
    logReadinessError("Could not load product passport readiness summary rows.", error);
    throw new Error("Could not load product passports.");
  }

  return (data ?? []) as ProductPassportRow[];
}

async function loadEconomicsForSeller(sellerId: string): Promise<ProductEconomicsRow[]> {
  const { data, error } = await supabase
    .from("amazon_product_economics")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    logReadinessError("Could not load product economics for passport readiness.", error);
    throw new Error("Could not load product economics.");
  }

  return (data ?? []) as ProductEconomicsRow[];
}

function buildProductReadiness(
  product: ProductPassportRow,
  economicsRows: ProductEconomicsRow[]
): ProductReadiness {
  const completeness = calculatePassportCompleteness(product);
  const economicsMatch = matchEconomics(product, economicsRows);
  const profitGuardrail = buildProfitGuardrail(economicsMatch.row);
  const adReadiness = buildAdReadiness({
    completeness,
    economics: economicsMatch.row,
    profitStatus: profitGuardrail.profitStatus
  });

  return {
    ok: true,
    productPassportId: product.id,
    sellerId: product.seller_id,
    product: {
      id: product.id,
      sku: product.sku,
      asin: product.asin,
      productName: product.product_name,
      brand: product.brand,
      category: product.category,
      status: product.status
    },
    passportCompleteness: completeness,
    economicsLink: {
      status: economicsMatch.status,
      matchType: economicsMatch.matchType,
      economicsId: economicsMatch.row?.id ?? null
    },
    profitGuardrail,
    adReadiness,
    nextBestAction: buildNextBestAction({
      economics: economicsMatch.row,
      completeness,
      profitStatus: profitGuardrail.profitStatus,
      adReadinessStatus: adReadiness.status
    }),
    warnings: buildWarnings({
      completeness,
      economics: economicsMatch.row,
      profitStatus: profitGuardrail.profitStatus
    })
  };
}

export async function getProductPassportReadinessById(id: string): Promise<ProductReadiness | null> {
  const product = await loadProductPassportById(id);

  if (!product) {
    return null;
  }

  const economicsRows = await loadEconomicsForSeller(product.seller_id);
  return buildProductReadiness(product, economicsRows);
}

export async function getProductPassportReadinessSummary(sellerId: string) {
  const [products, economicsRows] = await Promise.all([
    loadProductPassportsForSeller(sellerId),
    loadEconomicsForSeller(sellerId)
  ]);
  const readinessRows = products.map((product) => buildProductReadiness(product, economicsRows));
  const rows = readinessRows.map((readiness) => ({
    id: readiness.product.id,
    sku: readiness.product.sku,
    asin: readiness.product.asin,
    productName: readiness.product.productName,
    category: readiness.product.category,
    status: readiness.product.status,
    passportScore: readiness.passportCompleteness.score,
    economicsStatus: readiness.economicsLink.status,
    profitStatus: readiness.profitGuardrail.profitStatus,
    adReadinessStatus: readiness.adReadiness.status,
    nextBestAction: readiness.nextBestAction.title
  }));

  return {
    ok: true,
    sellerId,
    count: rows.length,
    summary: {
      readyCount: rows.filter((row) => row.adReadinessStatus === "READY").length,
      needsFixCount: rows.filter((row) => row.adReadinessStatus === "NEEDS_FIX").length,
      doNotScaleCount: rows.filter((row) => row.adReadinessStatus === "DO_NOT_SCALE").length,
      missingEconomicsCount: rows.filter((row) => row.economicsStatus === "MISSING").length
    },
    rows
  };
}
