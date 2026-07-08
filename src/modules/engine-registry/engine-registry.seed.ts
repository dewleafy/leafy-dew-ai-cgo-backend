import {
  EngineCategory,
  EngineDefinition,
  EngineRuleTemplate
} from "./engine-registry.types";

type CategoryPlan = {
  category: EngineCategory;
  count: number;
  ownerModule: string;
  priorityMin: number;
  priorityMax: number;
  dataSources: string[];
  subcategories: string[];
  focusAreas: string[];
  templates: EngineRuleTemplate[];
  outputActionTypes: string[];
  entityTypes: Array<string | null>;
  riskLevels: Array<"LOW" | "MEDIUM" | "HIGH">;
  costLevel: "LOW" | "MEDIUM";
  runFrequency: "DAILY" | "WEEKLY";
};

export const ENGINE_CATEGORY_COUNTS: Record<EngineCategory, number> = {
  DATA_QUALITY: 25,
  PRODUCT_ECONOMICS: 30,
  PPC: 35,
  LISTING_SEO: 35,
  LISTING_CONVERSION: 25,
  INVENTORY: 20,
  PRICING: 20,
  ACCOUNT_HEALTH: 15,
  RETURNS_REVIEWS: 15,
  COMPETITOR_INTELLIGENCE: 15,
  SEASONALITY: 15,
  CONTENT_A_PLUS: 15,
  IMAGE_CREATIVE: 15,
  BRAND_STORE: 10,
  SOCIAL_CONTENT: 10
};

export const ALLOWED_RULE_TEMPLATES: EngineRuleTemplate[] = [
  "MISSING_DATA_CHECK",
  "PROFIT_GUARDRAIL_CHECK",
  "ACOS_GUARDRAIL_CHECK",
  "ROAS_OPPORTUNITY_CHECK",
  "KEYWORD_OPPORTUNITY_CHECK",
  "NEGATIVE_KEYWORD_REVIEW",
  "LISTING_READINESS_CHECK",
  "LISTING_SEO_GAP_CHECK",
  "CONVERSION_RISK_CHECK",
  "INVENTORY_RISK_CHECK",
  "PRICING_RISK_CHECK",
  "ACCOUNT_HEALTH_CHECK",
  "RETURN_REVIEW_RISK_CHECK",
  "COMPETITOR_GAP_CHECK",
  "SEASONAL_OPPORTUNITY_CHECK",
  "CONTENT_GAP_CHECK",
  "IMAGE_GAP_CHECK",
  "BRAND_STORE_GAP_CHECK",
  "SOCIAL_CALENDAR_CHECK",
  "GENERIC_REVIEW"
];

const CATEGORY_PLANS: CategoryPlan[] = [
  {
    category: "DATA_QUALITY",
    count: 25,
    ownerModule: "data-quality",
    priorityMin: 80,
    priorityMax: 95,
    dataSources: ["product_passports", "amazon_product_economics", "amazon_sp"],
    subcategories: ["cost_data", "catalog_data", "identifier_data", "sync_freshness", "readiness_data"],
    focusAreas: ["landed cost", "selling price", "SKU mapping", "ASIN mapping", "brand value", "category value", "image URL", "SEO keyword", "supplier cost", "package data"],
    templates: ["MISSING_DATA_CHECK"],
    outputActionTypes: ["COST_DATA_REQUIRED", "LISTING_READINESS_REVIEW"],
    entityTypes: ["SKU", "ASIN"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "PRODUCT_ECONOMICS",
    count: 30,
    ownerModule: "product-economics",
    priorityMin: 80,
    priorityMax: 100,
    dataSources: ["amazon_product_economics", "product_passports", "ai_recommendations"],
    subcategories: ["profit_guardrail", "margin_band", "break_even_acos", "cost_drift", "scale_readiness"],
    focusAreas: ["profit band", "break-even ACOS", "minimum profit", "landed cost drift", "fee estimate", "shipping estimate", "low price margin", "mid price margin"],
    templates: ["PROFIT_GUARDRAIL_CHECK", "MISSING_DATA_CHECK"],
    outputActionTypes: ["PROFIT_RISK_REVIEW", "COST_DATA_REQUIRED"],
    entityTypes: ["SKU", "ASIN"],
    riskLevels: ["HIGH", "MEDIUM"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "PPC",
    count: 35,
    ownerModule: "amazon-ads",
    priorityMin: 70,
    priorityMax: 96,
    dataSources: ["amazon_ads_profiles", "amazon_ads_campaigns", "amazon_ads_reports", "amazon_product_economics"],
    subcategories: ["acos_guardrail", "keyword_growth", "product_targeting", "negative_keywords", "budget_efficiency", "bid_efficiency"],
    focusAreas: ["high ACOS", "low ROAS", "exact keyword opportunity", "product target opportunity", "wasted spend", "search term review", "budget cap", "bid pressure", "campaign readiness"],
    templates: ["ACOS_GUARDRAIL_CHECK", "ROAS_OPPORTUNITY_CHECK", "KEYWORD_OPPORTUNITY_CHECK", "NEGATIVE_KEYWORD_REVIEW"],
    outputActionTypes: ["PPC_GUARDRAIL_REVIEW", "ADD_EXACT_KEYWORD_AFTER_APPROVAL", "ADD_PRODUCT_TARGET_AFTER_APPROVAL", "CHECK_LISTING_BEFORE_NEGATIVE"],
    entityTypes: ["CAMPAIGN", "KEYWORD", "ASIN", "SEARCH_TERM"],
    riskLevels: ["HIGH", "MEDIUM", "MEDIUM"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "LISTING_SEO",
    count: 35,
    ownerModule: "listing-readiness",
    priorityMin: 60,
    priorityMax: 85,
    dataSources: ["product_passports", "listing_readiness"],
    subcategories: ["title_seo", "bullet_seo", "backend_terms", "keyword_coverage", "category_fit"],
    focusAreas: ["title keyword gap", "bullet keyword gap", "backend search term gap", "category keyword fit", "long-tail coverage", "keyword duplication", "brand keyword placement"],
    templates: ["LISTING_SEO_GAP_CHECK", "LISTING_READINESS_CHECK"],
    outputActionTypes: ["LISTING_SEO_REVIEW", "LISTING_READINESS_REVIEW"],
    entityTypes: ["ASIN", "SKU"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "LISTING_CONVERSION",
    count: 25,
    ownerModule: "listing-readiness",
    priorityMin: 60,
    priorityMax: 85,
    dataSources: ["product_passports", "listing_readiness", "amazon_sp"],
    subcategories: ["listing_readiness", "trust_gaps", "bullet_quality", "image_readiness", "offer_clarity"],
    focusAreas: ["listing readiness", "trust signal gap", "bullet clarity", "offer clarity", "customer objection coverage", "feature benefit match", "conversion warning"],
    templates: ["LISTING_READINESS_CHECK", "CONVERSION_RISK_CHECK"],
    outputActionTypes: ["LISTING_READINESS_REVIEW", "LISTING_CONVERSION_REVIEW"],
    entityTypes: ["ASIN", "SKU"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "INVENTORY",
    count: 20,
    ownerModule: "inventory",
    priorityMin: 65,
    priorityMax: 90,
    dataSources: ["amazon_sp", "product_passports", "amazon_ads_reports"],
    subcategories: ["stockout_risk", "overstock_risk", "restock_planning", "sales_velocity", "ad_inventory_alignment"],
    focusAreas: ["stockout risk", "overstock risk", "restock lead time", "sales velocity", "ad spend versus inventory", "low cover days", "inventory freshness"],
    templates: ["INVENTORY_RISK_CHECK"],
    outputActionTypes: ["INVENTORY_RISK_REVIEW"],
    entityTypes: ["SKU", "ASIN"],
    riskLevels: ["HIGH", "MEDIUM"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "PRICING",
    count: 20,
    ownerModule: "pricing",
    priorityMin: 65,
    priorityMax: 90,
    dataSources: ["amazon_product_economics", "product_passports", "competitor_snapshots"],
    subcategories: ["margin_protection", "price_gap", "discount_guardrail", "buy_box_readiness", "promo_readiness"],
    focusAreas: ["margin protection", "price gap", "discount guardrail", "buy box readiness", "promo floor", "price change risk", "low price exposure"],
    templates: ["PRICING_RISK_CHECK", "PROFIT_GUARDRAIL_CHECK"],
    outputActionTypes: ["PRICING_REVIEW", "PROFIT_RISK_REVIEW"],
    entityTypes: ["SKU", "ASIN"],
    riskLevels: ["HIGH", "MEDIUM"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "ACCOUNT_HEALTH",
    count: 15,
    ownerModule: "account-health",
    priorityMin: 85,
    priorityMax: 100,
    dataSources: ["amazon_sp", "activity_logs", "action_ledger"],
    subcategories: ["policy_risk", "suppression_risk", "account_metric", "compliance_gap", "case_followup"],
    focusAreas: ["policy warning", "listing suppression", "account metric", "compliance gap", "case follow-up", "restricted product signal"],
    templates: ["ACCOUNT_HEALTH_CHECK"],
    outputActionTypes: ["ACCOUNT_HEALTH_REVIEW"],
    entityTypes: ["ACCOUNT", "ASIN"],
    riskLevels: ["HIGH", "MEDIUM"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "RETURNS_REVIEWS",
    count: 15,
    ownerModule: "returns-reviews",
    priorityMin: 55,
    priorityMax: 83,
    dataSources: ["amazon_sp", "product_passports", "review_snapshots"],
    subcategories: ["return_rate", "review_quality", "rating_risk", "voice_of_customer", "defect_pattern"],
    focusAreas: ["return rate", "low rating", "review theme", "defect pattern", "buyer confusion", "quality warning"],
    templates: ["RETURN_REVIEW_RISK_CHECK"],
    outputActionTypes: ["RETURN_RISK_REVIEW", "REVIEW_RISK_REVIEW"],
    entityTypes: ["ASIN", "SKU"],
    riskLevels: ["HIGH", "MEDIUM", "LOW"],
    costLevel: "LOW",
    runFrequency: "DAILY"
  },
  {
    category: "COMPETITOR_INTELLIGENCE",
    count: 15,
    ownerModule: "competitor-intelligence",
    priorityMin: 50,
    priorityMax: 78,
    dataSources: ["product_passports", "competitor_snapshots"],
    subcategories: ["competitor_offer", "competitor_content", "competitor_price", "competitor_reviews", "market_gap"],
    focusAreas: ["competitor price gap", "competitor image gap", "competitor A plus gap", "review moat", "market angle", "offer gap"],
    templates: ["COMPETITOR_GAP_CHECK"],
    outputActionTypes: ["COMPETITOR_GAP_REVIEW"],
    entityTypes: ["ASIN", "SKU"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "LOW",
    runFrequency: "WEEKLY"
  },
  {
    category: "SEASONALITY",
    count: 15,
    ownerModule: "seasonality",
    priorityMin: 45,
    priorityMax: 75,
    dataSources: ["amazon_ads_reports", "sales_history", "seasonal_calendar"],
    subcategories: ["seasonal_demand", "promo_calendar", "holiday_readiness", "inventory_timing", "content_timing"],
    focusAreas: ["seasonal demand", "holiday readiness", "promo calendar", "inventory timing", "content timing", "search trend"],
    templates: ["SEASONAL_OPPORTUNITY_CHECK"],
    outputActionTypes: ["SEASONAL_ACTION_REVIEW"],
    entityTypes: ["SKU", "ASIN"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "LOW",
    runFrequency: "WEEKLY"
  },
  {
    category: "CONTENT_A_PLUS",
    count: 15,
    ownerModule: "content-a-plus",
    priorityMin: 35,
    priorityMax: 75,
    dataSources: ["product_passports", "listing_readiness", "brand_assets"],
    subcategories: ["a_plus_readiness", "comparison_chart", "brand_story", "module_gap", "proof_points"],
    focusAreas: ["A plus readiness", "comparison chart", "brand story", "module gap", "proof point", "content claim"],
    templates: ["CONTENT_GAP_CHECK"],
    outputActionTypes: ["A_PLUS_CONTENT_REVIEW"],
    entityTypes: ["ASIN", "SKU"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "MEDIUM",
    runFrequency: "WEEKLY"
  },
  {
    category: "IMAGE_CREATIVE",
    count: 15,
    ownerModule: "image-creative",
    priorityMin: 35,
    priorityMax: 75,
    dataSources: ["product_passports", "listing_readiness", "brand_assets"],
    subcategories: ["main_image", "lifestyle_image", "infographic", "comparison_image", "trust_image"],
    focusAreas: ["main image", "lifestyle image", "infographic", "comparison image", "trust image", "image sequence"],
    templates: ["IMAGE_GAP_CHECK"],
    outputActionTypes: ["IMAGE_CREATIVE_REVIEW"],
    entityTypes: ["ASIN", "SKU"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "MEDIUM",
    runFrequency: "WEEKLY"
  },
  {
    category: "BRAND_STORE",
    count: 10,
    ownerModule: "brand-store",
    priorityMin: 35,
    priorityMax: 70,
    dataSources: ["brand_assets", "product_passports", "brand_store_snapshots"],
    subcategories: ["store_readiness", "collection_gap", "navigation_gap", "hero_content", "seasonal_storefront"],
    focusAreas: ["store readiness", "collection gap", "navigation gap", "hero content", "seasonal storefront"],
    templates: ["BRAND_STORE_GAP_CHECK"],
    outputActionTypes: ["BRAND_STORE_REVIEW"],
    entityTypes: ["BRAND_STORE", "ASIN"],
    riskLevels: ["MEDIUM", "LOW"],
    costLevel: "MEDIUM",
    runFrequency: "WEEKLY"
  },
  {
    category: "SOCIAL_CONTENT",
    count: 10,
    ownerModule: "social-content",
    priorityMin: 35,
    priorityMax: 70,
    dataSources: ["product_passports", "seasonal_calendar", "brand_assets"],
    subcategories: ["calendar", "post_draft", "reel_idea", "ugc_brief", "promo_social"],
    focusAreas: ["social calendar", "post draft", "reel idea", "UGC brief", "promo social"],
    templates: ["SOCIAL_CALENDAR_CHECK"],
    outputActionTypes: ["SOCIAL_POST_DRAFT_REVIEW"],
    entityTypes: ["SOCIAL_CHANNEL", "SKU"],
    riskLevels: ["LOW", "MEDIUM"],
    costLevel: "MEDIUM",
    runFrequency: "WEEKLY"
  }
];

const STARTER_ENGINES: EngineDefinition[] = [
  starter("COST_DATA_COMPLETION_ENGINE", "Cost Data Completion Engine", "DATA_QUALITY", "cost_data", "Checks whether landed cost, selling price, fees, and non-ad costs are complete before growth recommendations.", "MISSING_DATA_CHECK", "COST_DATA_REQUIRED", "SKU", "MEDIUM", "LOW", 95, "product-passports", ["product_passports", "amazon_product_economics"], ["selling_price", "landed_cost", "non_ad_cost"]),
  starter("PROFIT_RISK_ENGINE", "Profit Risk Engine", "PRODUCT_ECONOMICS", "profit_guardrail", "Reviews product economics for profit risk before PPC scale, pricing, or promotion actions are proposed.", "PROFIT_GUARDRAIL_CHECK", "PROFIT_RISK_REVIEW", "SKU", "HIGH", "LOW", 98, "product-economics", ["amazon_product_economics", "product_passports"], ["selling_price", "landed_cost", "target_acos"]),
  starter("PPC_GUARDRAIL_ENGINE", "PPC Guardrail Engine", "PPC", "acos_guardrail", "Reviews ACOS and ROAS guardrails in shadow mode before any PPC recommendation can move toward approval.", "ACOS_GUARDRAIL_CHECK", "PPC_GUARDRAIL_REVIEW", "CAMPAIGN", "HIGH", "LOW", 96, "amazon-ads", ["amazon_ads_reports", "amazon_product_economics"], ["campaign_performance", "target_acos", "profit_guardrail"]),
  starter("ACCOUNT_HEALTH_ENGINE", "Account Health Engine", "ACCOUNT_HEALTH", "account_metric", "Reviews account health signals and policy risk so founders can prioritize safe manual follow-up.", "ACCOUNT_HEALTH_CHECK", "ACCOUNT_HEALTH_REVIEW", "ACCOUNT", "HIGH", "LOW", 94, "account-health", ["amazon_sp", "activity_logs"], ["account_health_status", "policy_signals"]),
  starter("LISTING_READINESS_ENGINE", "Listing Readiness Engine", "LISTING_CONVERSION", "listing_readiness", "Checks listing readiness across content, trust, image, SEO, and profit inputs before traffic scale.", "LISTING_READINESS_CHECK", "LISTING_READINESS_REVIEW", "ASIN", "MEDIUM", "LOW", 85, "listing-readiness", ["product_passports", "listing_readiness"], ["title", "bullets", "images", "seo_keywords"]),
  starter("KEYWORD_OPPORTUNITY_ENGINE", "Keyword Opportunity Engine", "PPC", "keyword_growth", "Finds exact keyword opportunities for approval review without creating ads or keywords automatically.", "KEYWORD_OPPORTUNITY_CHECK", "ADD_EXACT_KEYWORD_AFTER_APPROVAL", "KEYWORD", "MEDIUM", "LOW", 86, "amazon-ads", ["amazon_ads_reports", "amazon_product_economics"], ["search_terms", "conversion_rate", "acos"]),
  starter("PRODUCT_TARGET_OPPORTUNITY_ENGINE", "Product Target Opportunity Engine", "PPC", "product_targeting", "Finds ASIN product targeting opportunities for approval review without changing campaigns.", "ROAS_OPPORTUNITY_CHECK", "ADD_PRODUCT_TARGET_AFTER_APPROVAL", "ASIN", "MEDIUM", "LOW", 84, "amazon-ads", ["amazon_ads_reports", "competitor_snapshots"], ["asin_performance", "roas", "conversion_rate"]),
  starter("NEGATIVE_KEYWORD_REVIEW_ENGINE", "Negative Keyword Review Engine", "PPC", "negative_keywords", "Reviews negative keyword candidates and routes listing checks before any suppression recommendation.", "NEGATIVE_KEYWORD_REVIEW", "CHECK_LISTING_BEFORE_NEGATIVE", "SEARCH_TERM", "MEDIUM", "LOW", 82, "amazon-ads", ["amazon_ads_reports", "listing_readiness"], ["search_terms", "spend", "listing_relevance"]),
  starter("SOCIAL_CALENDAR_ENGINE", "Social Calendar Engine", "SOCIAL_CONTENT", "calendar", "Previews social content calendar gaps for founder review without publishing or drafting through external tools.", "SOCIAL_CALENDAR_CHECK", "SOCIAL_POST_DRAFT_REVIEW", "SOCIAL_CHANNEL", "LOW", "MEDIUM", 62, "social-content", ["product_passports", "seasonal_calendar"], ["product_theme", "seasonal_event"]),
  starter("A_PLUS_CONTENT_ENGINE", "A Plus Content Engine", "CONTENT_A_PLUS", "a_plus_readiness", "Reviews A+ content readiness and module gaps for approval-first content planning.", "CONTENT_GAP_CHECK", "A_PLUS_CONTENT_REVIEW", "ASIN", "MEDIUM", "MEDIUM", 70, "content-a-plus", ["product_passports", "brand_assets"], ["brand_story", "modules", "proof_points"]),
  starter("IMAGE_MAIN_IMAGE_REVIEW_ENGINE", "Main Image Review Engine", "IMAGE_CREATIVE", "main_image", "Reviews main image readiness signals for approval-first creative improvement planning.", "IMAGE_GAP_CHECK", "IMAGE_CREATIVE_REVIEW", "ASIN", "MEDIUM", "MEDIUM", 72, "image-creative", ["product_passports", "listing_readiness"], ["main_image_url", "image_count", "image_requirements"]),
  starter("BRAND_STORE_READINESS_ENGINE", "Brand Store Readiness Engine", "BRAND_STORE", "store_readiness", "Reviews brand store readiness and navigation gaps without publishing store changes.", "BRAND_STORE_GAP_CHECK", "BRAND_STORE_REVIEW", "BRAND_STORE", "MEDIUM", "MEDIUM", 68, "brand-store", ["brand_assets", "brand_store_snapshots"], ["store_pages", "navigation", "hero_content"]),
  starter("INVENTORY_STOCKOUT_RISK_ENGINE", "Inventory Stockout Risk Engine", "INVENTORY", "stockout_risk", "Reviews stockout risk using velocity and inventory signals before traffic or promo changes are suggested.", "INVENTORY_RISK_CHECK", "INVENTORY_RISK_REVIEW", "SKU", "HIGH", "LOW", 90, "inventory", ["amazon_sp", "amazon_ads_reports"], ["inventory_quantity", "sales_velocity", "cover_days"]),
  starter("PRICING_MARGIN_PROTECTION_ENGINE", "Pricing Margin Protection Engine", "PRICING", "margin_protection", "Checks margin protection rules before discount, price, or promotion recommendations are proposed.", "PRICING_RISK_CHECK", "PRICING_REVIEW", "SKU", "HIGH", "LOW", 92, "pricing", ["amazon_product_economics", "product_passports"], ["selling_price", "landed_cost", "min_profit"]),
  starter("RETURN_RATE_RISK_ENGINE", "Return Rate Risk Engine", "RETURNS_REVIEWS", "return_rate", "Reviews return-rate risk and related buyer confusion signals for founder follow-up.", "RETURN_REVIEW_RISK_CHECK", "RETURN_RISK_REVIEW", "ASIN", "HIGH", "LOW", 83, "returns-reviews", ["amazon_sp", "review_snapshots"], ["return_rate", "review_themes", "defect_signals"])
];

function starter(
  engineKey: string,
  engineName: string,
  category: EngineCategory,
  subcategory: string,
  description: string,
  ruleTemplate: EngineRuleTemplate,
  outputActionType: string,
  outputEntityType: string,
  riskLevel: "LOW" | "MEDIUM" | "HIGH",
  costLevel: "LOW" | "MEDIUM",
  priorityScore: number,
  ownerModule: string,
  dataSources: string[],
  inputRequirements: string[]
): EngineDefinition {
  return {
    engineKey,
    engineName,
    category,
    subcategory,
    description,
    inputRequirements,
    dataSources,
    ruleTemplate,
    ruleConfig: {
      starterEngine: true,
      approvalFirst: true,
      externalExecution: false,
      shadowMode: true,
      minConfidenceScore: 70
    },
    outputActionType,
    outputEntityType,
    riskLevel,
    costLevel,
    priorityScore,
    runFrequency: "DAILY",
    enabled: true,
    shadowMode: true,
    requiresApproval: true,
    ownerModule,
    version: "v1"
  };
}

function toTitle(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function pick<T>(items: T[], index: number): T {
  return items[index % items.length];
}

function priorityFor(plan: CategoryPlan, index: number): number {
  const span = plan.priorityMax - plan.priorityMin;
  if (span <= 0) return plan.priorityMin;
  return plan.priorityMax - (index % (span + 1));
}

function buildGeneratedEngine(plan: CategoryPlan, index: number, keyIndex: number): EngineDefinition {
  const subcategory = pick(plan.subcategories, index);
  const focusArea = pick(plan.focusAreas, index);
  const ruleTemplate = pick(plan.templates, index);
  const outputActionType = pick(plan.outputActionTypes, index);
  const outputEntityType = pick(plan.entityTypes, index);
  const riskLevel = pick(plan.riskLevels, index);
  const engineKey = `${plan.category}_${toKey(subcategory)}_${String(keyIndex).padStart(2, "0")}_ENGINE`;
  const focusTitle = toTitle(focusArea);

  return {
    engineKey,
    engineName: `${focusTitle} Review Engine`,
    category: plan.category,
    subcategory,
    description: `Reviews ${focusArea} signals for ${toTitle(plan.category)} and prepares an approval-first ${toTitle(outputActionType)} item when needed.`,
    inputRequirements: [
      `${subcategory}_signals`,
      `${focusArea.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_inputs`,
      "seller_context"
    ],
    dataSources: plan.dataSources,
    ruleTemplate,
    ruleConfig: {
      focusArea,
      subcategory,
      lookbackDays: plan.runFrequency === "DAILY" ? 14 : 30,
      minConfidenceScore: riskLevel === "HIGH" ? 80 : 65,
      approvalFirst: true,
      externalExecution: false,
      shadowMode: true
    },
    outputActionType,
    outputEntityType,
    riskLevel,
    costLevel: plan.costLevel,
    priorityScore: priorityFor(plan, index),
    runFrequency: plan.runFrequency,
    enabled: true,
    shadowMode: true,
    requiresApproval: true,
    ownerModule: plan.ownerModule,
    version: "v1"
  };
}

function categoryCounts(engines: EngineDefinition[]): Record<string, number> {
  return engines.reduce<Record<string, number>>((counts, engine) => {
    counts[engine.category] = (counts[engine.category] ?? 0) + 1;
    return counts;
  }, {});
}

function assertValidEngineSeed(engines: EngineDefinition[]): void {
  if (engines.length !== 300) {
    throw new Error(`Engine seed validation failed: expected 300 engines, generated ${engines.length}.`);
  }

  const keys = new Set<string>();
  for (const engine of engines) {
    if (keys.has(engine.engineKey)) {
      throw new Error(`Engine seed validation failed: duplicate engine_key ${engine.engineKey}.`);
    }
    keys.add(engine.engineKey);

    if (engine.shadowMode !== true) {
      throw new Error(`Engine seed validation failed: ${engine.engineKey} is not shadow_mode=true.`);
    }
    if (engine.requiresApproval !== true) {
      throw new Error(`Engine seed validation failed: ${engine.engineKey} is not requires_approval=true.`);
    }
    if (engine.enabled === undefined) {
      throw new Error(`Engine seed validation failed: ${engine.engineKey} has enabled undefined.`);
    }
    if (!engine.outputActionType) {
      throw new Error(`Engine seed validation failed: ${engine.engineKey} is missing output_action_type.`);
    }
    if (!ALLOWED_RULE_TEMPLATES.includes(engine.ruleTemplate)) {
      throw new Error(`Engine seed validation failed: ${engine.engineKey} uses unsupported rule_template.`);
    }
  }

  const counts = categoryCounts(engines);
  for (const [category, expectedCount] of Object.entries(ENGINE_CATEGORY_COUNTS)) {
    const actualCount = counts[category] ?? 0;
    if (actualCount !== expectedCount) {
      throw new Error(`Engine seed validation failed: ${category} expected ${expectedCount}, generated ${actualCount}.`);
    }
  }
}

export function getEngineSeedDefinitions(): EngineDefinition[] {
  const engines: EngineDefinition[] = [...STARTER_ENGINES];
  const usedKeys = new Set(engines.map((engine) => engine.engineKey));

  for (const plan of CATEGORY_PLANS) {
    const existingForCategory = engines.filter((engine) => engine.category === plan.category).length;
    const needed = plan.count - existingForCategory;

    for (let index = 0; index < needed; index += 1) {
      let keyIndex = index + 1;
      let engine = buildGeneratedEngine(plan, index, keyIndex);

      while (usedKeys.has(engine.engineKey)) {
        keyIndex += 1;
        engine = buildGeneratedEngine(plan, index, keyIndex);
      }

      engines.push(engine);
      usedKeys.add(engine.engineKey);
    }
  }

  assertValidEngineSeed(engines);
  return engines;
}

export function getEngineSeedCategoryCounts(engines: EngineDefinition[]): Record<string, number> {
  return categoryCounts(engines);
}
