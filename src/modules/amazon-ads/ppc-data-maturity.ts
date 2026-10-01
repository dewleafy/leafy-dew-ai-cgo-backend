// PPC data-maturity gate — Blueprint v2.2 §12 "PPC Automation Guardrails".
//
// A recommendation may only become an approval card when it rests on enough real data:
//   - no bid cut from one bad day              -> bid reduction needs >= 3 days of data
//   - no pause before the mature lookback      -> negatives need >= 7 days of history
//   - no scale-up unless profit rules pass     -> scale suggestions need profit status PASS
//   - harvesting needs search-term evidence    -> exact/ASIN targets need >= 7 days of history
// Anything that fails is "held back": it is downgraded to a monitor/watchlist note (never an
// approval-worthy action) and the reason is recorded, so nothing silently disappears.
//
// Pure functions only (no database), so the rules can be unit-tested and tuned in one place.

export type PpcMaturityCategory =
  | "exactMatchOpportunities"
  | "productTargetingOpportunities"
  | "watchlistWasteTerms"
  | "negativeKeywordCandidates"
  | "negativeProductTargetCandidates"
  | "bidDownCandidates"
  | "productPageCheckWarnings"
  | "profitRiskWarnings"
  | "monitorOnlyTerms";

type MaturityRule = {
  /** Distinct report days in which the term actually had data. */
  minObservedDays: number;
  /** Days between the first and last day the term had data (so a brand-new term waits). */
  minSpanDays: number;
  minClicks: number;
  requiresProfitPass: boolean;
  /** Where a held-back suggestion goes instead. */
  downgradeTo: "watchlistWasteTerms" | "monitorOnlyTerms";
  /** The blueprint §12 row this rule comes from, shown in the reason. */
  blueprintRule: string;
};

// Tune thresholds HERE. Defaults follow blueprint §12's minimum data windows.
export const PPC_MATURITY_RULES: Partial<Record<PpcMaturityCategory, MaturityRule>> = {
  profitRiskWarnings: {
    minObservedDays: 3,
    minSpanDays: 0,
    minClicks: 5,
    requiresProfitPass: false,
    downgradeTo: "monitorOnlyTerms",
    blueprintRule: "CTR trend / directional alert needs 2-3 days of data"
  },
  bidDownCandidates: {
    minObservedDays: 3,
    minSpanDays: 0,
    minClicks: 5,
    requiresProfitPass: false,
    downgradeTo: "monitorOnlyTerms",
    blueprintRule: "Bid reduction needs 3-7 days (no bid cut from one bad day)"
  },
  negativeKeywordCandidates: {
    minObservedDays: 3,
    minSpanDays: 7,
    minClicks: 8,
    requiresProfitPass: false,
    downgradeTo: "watchlistWasteTerms",
    blueprintRule: "No pause/negative before the mature lookback window (7 days)"
  },
  negativeProductTargetCandidates: {
    minObservedDays: 3,
    minSpanDays: 7,
    minClicks: 8,
    requiresProfitPass: false,
    downgradeTo: "watchlistWasteTerms",
    blueprintRule: "No pause/negative before the mature lookback window (7 days)"
  },
  exactMatchOpportunities: {
    minObservedDays: 3,
    minSpanDays: 7,
    minClicks: 3,
    requiresProfitPass: true,
    downgradeTo: "monitorOnlyTerms",
    blueprintRule: "Search-term harvesting needs 7 days; no scaling unless profit rules pass"
  },
  productTargetingOpportunities: {
    minObservedDays: 3,
    minSpanDays: 7,
    minClicks: 3,
    requiresProfitPass: true,
    downgradeTo: "monitorOnlyTerms",
    blueprintRule: "Search-term harvesting needs 7 days; no scaling unless profit rules pass"
  },
  productPageCheckWarnings: {
    minObservedDays: 2,
    minSpanDays: 0,
    minClicks: 3,
    requiresProfitPass: false,
    downgradeTo: "monitorOnlyTerms",
    blueprintRule: "CTR trend needs 2-3 days of data"
  }
  // watchlistWasteTerms and monitorOnlyTerms are already non-actionable: no gate needed.
};

export type PpcDataMaturity = {
  status: "MATURE" | "HELD_BACK";
  observedDays: number | null;
  spanDays: number | null;
  clicks: number;
  required: { observedDays: number; spanDays: number; clicks: number; profitPass: boolean } | null;
  blueprintRule: string | null;
  reasons: string[];
  downgradeTo: "watchlistWasteTerms" | "monitorOnlyTerms" | null;
};

export function evaluatePpcDataMaturity(input: {
  category: PpcMaturityCategory;
  clicks: number;
  /** null when unknown (e.g. an already-saved recommendation that did not store its dates). */
  observedDays: number | null;
  spanDays: number | null;
  profitStatus: string | null;
}): PpcDataMaturity {
  const rule = PPC_MATURITY_RULES[input.category];

  if (!rule) {
    return {
      status: "MATURE",
      observedDays: input.observedDays,
      spanDays: input.spanDays,
      clicks: input.clicks,
      required: null,
      blueprintRule: null,
      reasons: [],
      downgradeTo: null
    };
  }

  const reasons: string[] = [];

  if (input.clicks < rule.minClicks) {
    reasons.push(`only ${input.clicks} click(s), needs at least ${rule.minClicks}`);
  }
  if (input.observedDays !== null && input.observedDays < rule.minObservedDays) {
    reasons.push(`data on only ${input.observedDays} day(s), needs at least ${rule.minObservedDays}`);
  }
  if (input.spanDays !== null && input.spanDays < rule.minSpanDays) {
    reasons.push(`history spans only ${input.spanDays} day(s), needs at least ${rule.minSpanDays}`);
  }
  if (rule.requiresProfitPass && input.profitStatus !== "PASS") {
    reasons.push(`profit rules have not passed (status: ${input.profitStatus ?? "unknown"})`);
  }

  return {
    status: reasons.length === 0 ? "MATURE" : "HELD_BACK",
    observedDays: input.observedDays,
    spanDays: input.spanDays,
    clicks: input.clicks,
    required: {
      observedDays: rule.minObservedDays,
      spanDays: rule.minSpanDays,
      clicks: rule.minClicks,
      profitPass: rule.requiresProfitPass
    },
    blueprintRule: rule.blueprintRule,
    reasons,
    downgradeTo: reasons.length === 0 ? null : rule.downgradeTo
  };
}

/** Whole days between two YYYY-MM-DD dates, inclusive (same day => 1). */
export function inclusiveSpanDays(firstDate: string, lastDate: string): number {
  const first = Date.parse(`${firstDate}T00:00:00Z`);
  const last = Date.parse(`${lastDate}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return 1;
  return Math.round((last - first) / 86_400_000) + 1;
}

const RECOMMENDATION_TYPE_TO_CATEGORY: Record<string, PpcMaturityCategory> = {
  EXACT_MATCH_OPPORTUNITIES: "exactMatchOpportunities",
  PRODUCT_TARGETING_OPPORTUNITIES: "productTargetingOpportunities",
  WATCHLIST_WASTE_TERMS: "watchlistWasteTerms",
  NEGATIVE_KEYWORD_CANDIDATES: "negativeKeywordCandidates",
  NEGATIVE_PRODUCT_TARGET_CANDIDATES: "negativeProductTargetCandidates",
  BID_DOWN_CANDIDATES: "bidDownCandidates",
  PRODUCT_PAGE_CHECK_WARNINGS: "productPageCheckWarnings",
  PROFIT_RISK_WARNINGS: "profitRiskWarnings",
  MONITOR_ONLY_TERMS: "monitorOnlyTerms"
};

export function ppcCategoryFromRecommendationType(type: string | null | undefined): PpcMaturityCategory | null {
  return RECOMMENDATION_TYPE_TO_CATEGORY[String(type ?? "").toUpperCase()] ?? null;
}

/**
 * For recommendations that were ALREADY saved (ai_recommendations rows): decides whether the row
 * may still flow into the approval queue. Saved rows do not store how many days of data they
 * rested on, so only the click floor and (for scale suggestions) the profit status can be checked.
 */
/**
 * May this saved row enter the approval queue? Rows saved before the gate existed carry no
 * `dataMaturity` result in their evidence, so nobody ever checked how many days of data they
 * rest on: for gated categories they are held back until the next generate-and-save re-judges
 * them (which stamps the result). Rows stamped HELD_BACK stay out; stamped MATURE rows still
 * have to pass the click/profit check.
 */
export function savedRecommendationAllowed(row: {
  recommendationType: string | null | undefined;
  evidence: Record<string, unknown> | null | undefined;
  profitEvidence: Record<string, unknown> | null | undefined;
}): boolean {
  const category = ppcCategoryFromRecommendationType(row.recommendationType);
  if (!category || !PPC_MATURITY_RULES[category]) return true;

  const stamped = (row.evidence as Record<string, unknown> | null | undefined)?.dataMaturity as
    | { status?: string }
    | undefined;
  if (stamped?.status !== "MATURE") return false;

  return savedRecommendationMaturity(row)?.status !== "HELD_BACK";
}

export function savedRecommendationMaturity(row: {
  recommendationType: string | null | undefined;
  evidence: Record<string, unknown> | null | undefined;
  profitEvidence: Record<string, unknown> | null | undefined;
}): PpcDataMaturity | null {
  const category = ppcCategoryFromRecommendationType(row.recommendationType);
  if (!category) return null;

  const clicks = Number((row.evidence as Record<string, unknown> | null)?.clicks ?? 0);
  const profitStatus = (row.profitEvidence as Record<string, unknown> | null)?.profitStatus;

  return evaluatePpcDataMaturity({
    category,
    clicks: Number.isFinite(clicks) ? clicks : 0,
    observedDays: null,
    spanDays: null,
    profitStatus: typeof profitStatus === "string" ? profitStatus : null
  });
}
