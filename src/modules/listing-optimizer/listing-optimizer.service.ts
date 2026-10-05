import { supabase } from "../../db/supabase";
import { generateAiResponse } from "../ai-gateway/ai-gateway.service";
import { requireConnectedConnection } from "../amazon-sp/amazon-sp.service";
import { safeErrorMessage, toNumberOrNull } from "../amazon-sp/amazon-sp-utils";
import {
  confirmCompetitorBenchmarkCandidates,
  createCompetitorBenchmarkRun,
  extractTitleAndBulletsFromCatalogPayload,
  runCompetitorBenchmarkComparison
} from "../competitor-benchmark/competitor-benchmark.service";
import {
  CompetitorBenchmarkCandidateRow,
  CompetitorBenchmarkDataRow,
  CompetitorBenchmarkRunRow
} from "../competitor-benchmark/competitor-benchmark.types";
import { resolveBrandName } from "../brand-readiness/brand-readiness.service";
import { listProductPassports } from "../product-passports/product-passports.service";
import {
  CompetitorSummaryEntry,
  ListingOptimizerAnalysisRow,
  ListingOptimizerGap,
  ListingOptimizerSubScores,
  RunAnalysisInput,
  SafeListingOptimizerAnalysis,
  SubScoreInput,
  SubScoreKey,
  SubScoreResult
} from "./listing-optimizer.types";

export class ListingOptimizerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ListingOptimizerError";
    this.status = status;
  }
}

// Same weights as the founder's Conversion Score sheet v2 (Part A Step 2 of the spec). A
// sub-score with status "unknown" (no real or AI-judged input at all) is excluded from the
// overall Conversion Score and its weight is redistributed across the remaining known
// sub-scores -- this mirrors exactly how the existing Competitor Benchmark Tool already excludes
// an "unknown" Review Score from the competitor average instead of silently scoring it 0.
const WEIGHTS: Record<SubScoreKey, number> = {
  IS: 0.25,
  RS: 0.2,
  PS: 0.15,
  TS: 0.15,
  BS: 0.1,
  KS: 0.1,
  CSF: 0.05
};

const MAX_LISTING_IMAGES_FOR_IS = 7; // per the spec's IS formula, not the 9-image listing cap used elsewhere
const MAX_AI_RUBRIC_CALLS_PER_ANALYSIS = 25;

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function missingInput(reason: string): SubScoreInput {
  return { value: null, source: "missing", reason };
}

function realInput(value: number): SubScoreInput {
  return { value, source: "real_data", reason: null };
}

function manualInput(value: number): SubScoreInput {
  return { value, source: "manual_entry", reason: null };
}

function aiInput(value: number, reason: string | null): SubScoreInput {
  return { value, source: "ai_judged", reason };
}

// ---- Sub-score formulas (exact formulas from the founder's spec, Part A Step 2) ----

function computeImageScore(input: {
  imageCount: number | null;
  lifestylePresent: boolean | null;
  qualityScore: number | null; // 0-1
}): SubScoreResult {
  const inputs: Record<string, SubScoreInput> = {};
  let total = 0;
  let anyKnown = false;

  if (input.imageCount !== null) {
    const imagesTerm = clamp(input.imageCount, 0, MAX_LISTING_IMAGES_FOR_IS) * 10;
    inputs.images = realInput(input.imageCount);
    total += imagesTerm;
    anyKnown = true;
  } else {
    inputs.images = missingInput("No fetched listing image count available for this ASIN yet.");
  }

  if (input.lifestylePresent !== null) {
    const lifestyleTerm = (input.lifestylePresent ? 1 : 0) * 20;
    inputs.lifestyle = manualInput(input.lifestylePresent ? 1 : 0);
    total += lifestyleTerm;
    anyKnown = true;
  } else {
    inputs.lifestyle = missingInput("Whether a genuine lifestyle photo is present needs a human look -- answer this manually.");
  }

  if (input.qualityScore !== null) {
    const qualityTerm = clamp(input.qualityScore, 0, 1) * 20;
    inputs.quality = manualInput(clamp(input.qualityScore, 0, 1));
    total += qualityTerm;
    anyKnown = true;
  } else {
    inputs.quality = missingInput("Main-image quality (white background, sharp, 80-90% frame) needs a human look -- answer this manually.");
  }

  if (!anyKnown) {
    return { value: null, status: "unknown", inputs, notes: ["No image data at all -- IS could not be computed."] };
  }

  const hasAllInputs = input.imageCount !== null && input.lifestylePresent !== null && input.qualityScore !== null;
  return {
    value: round1(Math.min(100, total)),
    status: hasAllInputs ? "computed" : "partial",
    inputs,
    notes: hasAllInputs ? [] : ["Partial: missing inputs contribute 0 -- this is a floor, not the true score, until you answer the manual fields."]
  };
}

function computeReviewScore(input: { reviewCount: number | null; rating: number | null }): SubScoreResult {
  if (input.reviewCount === null || input.rating === null) {
    return {
      value: null,
      status: "unknown",
      inputs: {
        reviews: input.reviewCount === null ? missingInput("Amazon's SP-API does not expose review count to any seller for any ASIN -- enter it manually from Seller Central if you want this scored.") : manualInput(input.reviewCount),
        rating: input.rating === null ? missingInput("Amazon's SP-API does not expose rating to any seller for any ASIN -- enter it manually from Seller Central if you want this scored.") : manualInput(input.rating)
      },
      notes: ["Review Score is unknown -- excluded from the overall Conversion Score rather than scored 0, same as the Competitor Benchmark Tool already does for competitors."]
    };
  }

  const reviewsTerm = (clamp(input.reviewCount, 0, 200) / 200) * 60;
  const ratingTerm = ((clamp(input.rating, 1, 5) - 1) / 4) * 40;
  return {
    value: round1(reviewsTerm + ratingTerm),
    status: "computed",
    inputs: { reviews: manualInput(input.reviewCount), rating: manualInput(input.rating) },
    notes: []
  };
}

function computePriceScore(input: { price: number | null; competitorAveragePrice: number | null }): SubScoreResult {
  if (input.price === null) {
    return {
      value: null,
      status: "unknown",
      inputs: { price: missingInput("No fetched price for this listing yet."), comp: missingInput("N/A") },
      notes: []
    };
  }

  if (input.competitorAveragePrice === null || input.competitorAveragePrice <= 0) {
    return {
      value: null,
      status: "unknown",
      inputs: {
        price: realInput(input.price),
        comp: missingInput("No confirmed-and-fetched competitor prices yet -- Price Score needs at least one real comparison price.")
      },
      notes: ["Confirm and compare at least one competitor ASIN in the Competitor Benchmark Tool for this SKU, then re-run this analysis."]
    };
  }

  const comp = input.competitorAveragePrice;
  const price = input.price;
  const pctDiff = ((price - comp) / comp) * 100;
  const penaltyMultiplier = price > comp ? 2 : 1;
  const value = clamp(80 - pctDiff * penaltyMultiplier, 0, 100);

  return {
    value: round1(value),
    status: "computed",
    inputs: { price: realInput(price), comp: realInput(comp) },
    notes: []
  };
}

function titleLengthComponent(titleLength: number | null): { term: number; input: SubScoreInput } {
  if (titleLength === null) {
    return { term: 0, input: missingInput("No fetched title length for this listing yet.") };
  }
  // 1.0 inside the sheet's 150-200 char target band; scaled down the further outside it, down to 0.
  let score: number;
  if (titleLength >= 150 && titleLength <= 200) {
    score = 1;
  } else if (titleLength < 150) {
    score = clamp(titleLength / 150, 0, 1);
  } else {
    score = clamp(1 - (titleLength - 200) / 200, 0, 1);
  }
  return { term: score * 40, input: realInput(titleLength) };
}

function computeTitleScore(input: {
  titleLength: number | null;
  titleKeywordPresent: boolean | null; // real, deterministic text match -- never AI-guessed
  titleReadability: number | null; // 0-1, AI-judged or manual
  titleReadabilityReason: string | null;
}): SubScoreResult {
  const inputs: Record<string, SubScoreInput> = {};
  let total = 0;
  let anyKnown = false;

  const lengthResult = titleLengthComponent(input.titleLength);
  inputs.length = lengthResult.input;
  if (input.titleLength !== null) {
    total += lengthResult.term;
    anyKnown = true;
  }

  if (input.titleKeywordPresent !== null) {
    inputs.keyword = realInput(input.titleKeywordPresent ? 1 : 0);
    total += (input.titleKeywordPresent ? 1 : 0) * 20;
    anyKnown = true;
  } else {
    inputs.keyword = missingInput("No high-volume keyword list supplied for this run, or no real title text available -- give a keyword list to score this.");
  }

  if (input.titleReadability !== null) {
    inputs.readability = aiInput(clamp(input.titleReadability, 0, 1), input.titleReadabilityReason);
    total += clamp(input.titleReadability, 0, 1) * 40;
    anyKnown = true;
  } else {
    inputs.readability = missingInput("AI readability judging was unavailable for this run -- see warnings, or enter a manual 0-1 override.");
  }

  if (!anyKnown) {
    return { value: null, status: "unknown", inputs, notes: ["No title data at all -- TS could not be computed."] };
  }

  const complete = input.titleLength !== null && input.titleKeywordPresent !== null && input.titleReadability !== null;
  return {
    value: round1(Math.min(100, total)),
    status: complete ? "computed" : "partial",
    inputs,
    notes: complete ? [] : ["Partial: missing inputs contribute 0 -- this is a floor, not the true score."]
  };
}

function computeBulletScore(input: {
  bulletCount: number | null;
  bulletKeywordPresent: boolean | null; // real, deterministic
  bulletClarity: number | null; // 0-1, AI-judged
  bulletClarityReason: string | null;
  featureBenefit: number | null; // 0-1, AI-judged
  featureBenefitReason: string | null;
}): SubScoreResult {
  const inputs: Record<string, SubScoreInput> = {};
  let total = 0;
  let anyKnown = false;

  if (input.bulletCount !== null) {
    inputs.bullets = realInput(input.bulletCount);
    total += clamp(input.bulletCount, 0, 5) * 10;
    anyKnown = true;
  } else {
    inputs.bullets = missingInput("No fetched bullet count for this listing yet.");
  }

  if (input.bulletKeywordPresent !== null) {
    inputs.keyword = realInput(input.bulletKeywordPresent ? 1 : 0);
    total += (input.bulletKeywordPresent ? 1 : 0) * 20;
    anyKnown = true;
  } else {
    inputs.keyword = missingInput("No high-volume keyword list supplied for this run, or no real bullet text available -- give a keyword list to score this.");
  }

  if (input.bulletClarity !== null) {
    inputs.clarity = aiInput(clamp(input.bulletClarity, 0, 1), input.bulletClarityReason);
    total += clamp(input.bulletClarity, 0, 1) * 15;
    anyKnown = true;
  } else {
    inputs.clarity = missingInput("AI clarity judging was unavailable for this run -- see warnings, or enter a manual 0-1 override.");
  }

  if (input.featureBenefit !== null) {
    inputs.feature_benefit = aiInput(clamp(input.featureBenefit, 0, 1), input.featureBenefitReason);
    total += clamp(input.featureBenefit, 0, 1) * 15;
    anyKnown = true;
  } else {
    inputs.feature_benefit = missingInput("AI feature/benefit judging was unavailable for this run -- see warnings, or enter a manual 0-1 override.");
  }

  if (!anyKnown) {
    return { value: null, status: "unknown", inputs, notes: ["No bullet data at all -- BS could not be computed."] };
  }

  const complete = input.bulletCount !== null && input.bulletKeywordPresent !== null && input.bulletClarity !== null && input.featureBenefit !== null;
  return {
    value: round1(Math.min(100, total)),
    status: complete ? "computed" : "partial",
    inputs,
    notes: complete ? [] : ["Partial: missing inputs contribute 0 -- this is a floor, not the true score."]
  };
}

function computeKeywordScore(input: { highVolumeCoverage: number | null }): SubScoreResult {
  // ranking_strength has NO real data source anywhere: SP-API exposes no backend search-term rank
  // data to any seller for any ASIN. It is always "unknown" in this version -- never invented,
  // never guessed from sales rank or anything else that isn't actually keyword-rank data.
  const inputs: Record<string, SubScoreInput> = {
    ranking_strength: missingInput("Amazon's SP-API does not expose keyword search rank to sellers for any ASIN -- this half of KS can never be measured by this app.")
  };

  if (input.highVolumeCoverage === null) {
    inputs.high_volume_coverage = missingInput("No high-volume keyword list supplied for this run.");
    return { value: null, status: "unknown", inputs, notes: ["KS is fully unknown -- supply a keyword list to get at least the coverage half scored."] };
  }

  inputs.high_volume_coverage = realInput(clamp(input.highVolumeCoverage, 0, 1));
  const value = clamp(input.highVolumeCoverage, 0, 1) * 50;
  return {
    value: round1(value),
    status: "partial",
    inputs,
    notes: ["Partial by design: ranking_strength (the other half of this formula) has no real data source and is permanently excluded from this half's contribution, not scored 0 -- the number shown is coverage*50 only, out of a 100-point formula."]
  };
}

function computeCreativeScore(input: { hasAplus: boolean | null; hasVideo: boolean | null }): SubScoreResult {
  const inputs: Record<string, SubScoreInput> = {};
  let total = 0;
  let anyKnown = false;

  if (input.hasAplus !== null) {
    inputs.aplus = realInput(input.hasAplus ? 1 : 0);
    total += (input.hasAplus ? 1 : 0) * 50;
    anyKnown = true;
  } else {
    inputs.aplus = missingInput("A+ Content hasn't been checked for this ASIN yet -- run the A+ Content coverage check first.");
  }

  if (input.hasVideo !== null) {
    inputs.video = manualInput(input.hasVideo ? 1 : 0);
    total += (input.hasVideo ? 1 : 0) * 50;
    anyKnown = true;
  } else {
    inputs.video = missingInput("Listing video presence isn't tracked anywhere in this app yet -- answer this manually.");
  }

  if (!anyKnown) {
    return { value: null, status: "unknown", inputs, notes: ["No creative-strength data at all -- CSF could not be computed."] };
  }

  const complete = input.hasAplus !== null && input.hasVideo !== null;
  return {
    value: round1(Math.min(100, total)),
    status: complete ? "computed" : "partial",
    inputs,
    notes: complete ? [] : ["Partial: missing inputs contribute 0 -- this is a floor, not the true score."]
  };
}

function overallFromSubScores(subScores: ListingOptimizerSubScores): { overallScore: number | null; grade: string | null; weightNote: string | null } {
  const available = (Object.keys(WEIGHTS) as SubScoreKey[]).filter((key) => {
    const result = subScores[key];
    return result && result.status !== "unknown" && result.value !== null;
  });

  if (available.length === 0) {
    return { overallScore: null, grade: null, weightNote: "No sub-scores could be computed at all." };
  }

  const usedWeightTotal = available.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const weighted = available.reduce((sum, key) => sum + WEIGHTS[key] * (subScores[key]!.value as number), 0);
  const overallScore = round1(weighted / usedWeightTotal);

  const grade = overallScore >= 85 ? "Excellent" : overallScore >= 70 ? "Good" : overallScore >= 50 ? "Needs work" : "Weak";

  const missing = (Object.keys(WEIGHTS) as SubScoreKey[]).filter((key) => !available.includes(key));
  const weightNote = missing.length > 0
    ? `${missing.join(", ")} excluded (unknown) -- weights renormalized across the remaining ${available.length} sub-score(s).`
    : null;

  return { overallScore, grade, weightNote };
}

// ---- Real, literal keyword presence (never AI-guessed -- a straightforward text match) ----

function keywordPresentInText(keyword: string, text: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function titleKeywordPresence(keywords: string[], title: string | null): boolean | null {
  if (keywords.length === 0 || !title) return null;
  const primary = keywords[0];
  const first80 = title.slice(0, 80);
  return keywordPresentInText(primary, first80);
}

function bulletKeywordPresence(keywords: string[], bullets: string[]): boolean | null {
  if (keywords.length === 0 || bullets.length === 0) return null;
  const joined = bullets.join(" \n ");
  return keywords.some((keyword) => keywordPresentInText(keyword, joined));
}

function highVolumeCoverage(keywords: string[], title: string | null, bullets: string[]): number | null {
  if (keywords.length === 0) return null;
  const haystack = `${title ?? ""} \n ${bullets.join(" \n ")}`;
  if (!haystack.trim()) return null;
  const matched = keywords.filter((keyword) => keywordPresentInText(keyword, haystack));
  return matched.length / keywords.length;
}

// ---- AI rubric (PART C-1-style, text-only, via the existing AI Gateway) ----

type RubricJudgement = {
  titleReadability: number | null;
  titleReadabilityReason: string | null;
  bulletClarity: number | null;
  bulletClarityReason: string | null;
  featureBenefit: number | null;
  featureBenefitReason: string | null;
  aiBlockedReason: string | null;
};

function buildRubricPrompt(input: { title: string | null; bullets: string[] }): string {
  return [
    "You are an Amazon India listing auditor. Score the listing below on each item from 0 to 1 (decimals allowed), using the rubric, and give a one-line reason for each. Return strict JSON only, with exactly this shape and nothing else:",
    '{"scores": {"title_readability": 0.0, "bullet_clarity": 0.0, "feature_benefit": 0.0}, "reasons": {"title_readability": "", "bullet_clarity": "", "feature_benefit": ""}}',
    "",
    "Rubric:",
    "- title_readability: 1 if the title reads naturally (brand, product, key feature, size/quantity) and has no repeated words; reduce for keyword stuffing or awkward phrasing.",
    "- bullet_clarity: 1 if each bullet is one clear idea, scannable, no filler; reduce for vague or run-on bullets.",
    "- feature_benefit: 1 if bullets pair each feature with a customer benefit; reduce if bullets only list features with no stated benefit.",
    "",
    `Title: ${input.title ?? "(none available)"}`,
    `Bullets:\n${input.bullets.length ? input.bullets.map((b) => `- ${b}`).join("\n") : "(none available)"}`
  ].join("\n");
}

function parseRubricResponse(raw: string): { scores: Record<string, number>; reasons: Record<string, string> } | null {
  try {
    const parsed = JSON.parse(raw) as { scores?: Record<string, unknown>; reasons?: Record<string, unknown> };
    const scores: Record<string, number> = {};
    for (const key of ["title_readability", "bullet_clarity", "feature_benefit"]) {
      const value = Number(parsed.scores?.[key]);
      if (Number.isFinite(value)) scores[key] = clamp(value, 0, 1);
    }
    const reasons: Record<string, string> = {};
    for (const key of ["title_readability", "bullet_clarity", "feature_benefit"]) {
      const value = parsed.reasons?.[key];
      if (typeof value === "string" && value.trim()) reasons[key] = value.trim();
    }
    return { scores, reasons };
  } catch {
    return null;
  }
}

type AiRubricState = { calls: number; limit: number };

async function judgeListingWithRubric(input: {
  sellerId: string;
  listingLabel: string;
  title: string | null;
  bullets: string[];
  aiState: AiRubricState;
}): Promise<RubricJudgement> {
  const noData: RubricJudgement = {
    titleReadability: null,
    titleReadabilityReason: null,
    bulletClarity: null,
    bulletClarityReason: null,
    featureBenefit: null,
    featureBenefitReason: null,
    aiBlockedReason: "NO_TITLE_OR_BULLET_TEXT"
  };

  if (!input.title && input.bullets.length === 0) return noData;
  if (input.aiState.calls >= input.aiState.limit) {
    return { ...noData, aiBlockedReason: "AI_RUN_CALL_LIMIT_REACHED" };
  }

  try {
    const result = await generateAiResponse({
      sellerId: input.sellerId,
      moduleName: "LISTING_OPTIMIZER",
      purpose: "listing_optimizer_rubric",
      prompt: buildRubricPrompt({ title: input.title, bullets: input.bullets }),
      maxOutputTokens: 300,
      requestId: `listing-optimizer-rubric:${input.listingLabel}`,
      // The AI Gateway's security guardrail requires a founder/admin actor for AI_GENERATE calls
      // (confirmed in listing-drafts.service.ts) -- this only ever runs from a founder-triggered
      // "Analyze" click, never a background job.
      actor: "founder",
      metadata: { listingLabel: input.listingLabel, module: "LISTING_OPTIMIZER" }
    });

    if (result.ok || result.blockedReason === "AI_PROVIDER_CALL_FAILED") {
      input.aiState.calls += 1;
    }

    if (!result.ok || !result.output) {
      return { ...noData, aiBlockedReason: result.blockedReason ?? "AI_CALL_DID_NOT_RETURN_OUTPUT" };
    }

    const parsed = parseRubricResponse(result.output);
    if (!parsed) {
      return { ...noData, aiBlockedReason: "AI_RETURNED_UNPARSEABLE_JSON" };
    }

    return {
      titleReadability: parsed.scores.title_readability ?? null,
      titleReadabilityReason: parsed.reasons.title_readability ?? null,
      bulletClarity: parsed.scores.bullet_clarity ?? null,
      bulletClarityReason: parsed.reasons.bullet_clarity ?? null,
      featureBenefit: parsed.scores.feature_benefit ?? null,
      featureBenefitReason: parsed.reasons.feature_benefit ?? null,
      aiBlockedReason: null
    };
  } catch (error) {
    return { ...noData, aiBlockedReason: safeErrorMessage(error) };
  }
}

// ---- Per-listing sub-score assembly (same formula set for own listing and every competitor) ----

type ListingFacts = {
  label: string;
  price: number | null;
  imageCount: number | null;
  bulletCount: number | null;
  titleLength: number | null;
  title: string | null;
  bullets: string[];
};

async function scoreListing(input: {
  facts: ListingFacts;
  competitorAveragePrice: number | null;
  keywords: string[];
  hasAplus: boolean | null;
  hasVideo: boolean | null;
  lifestylePresent: boolean | null;
  qualityScore: number | null;
  reviewCount: number | null;
  rating: number | null;
  useAiJudging: boolean;
  sellerId: string;
  aiState: AiRubricState;
}): Promise<ListingOptimizerSubScores> {
  const rubric = input.useAiJudging
    ? await judgeListingWithRubric({
        sellerId: input.sellerId,
        listingLabel: input.facts.label,
        title: input.facts.title,
        bullets: input.facts.bullets,
        aiState: input.aiState
      })
    : {
        titleReadability: null,
        titleReadabilityReason: null,
        bulletClarity: null,
        bulletClarityReason: null,
        featureBenefit: null,
        featureBenefitReason: null,
        aiBlockedReason: "AI_JUDGING_DISABLED_FOR_THIS_RUN"
      };

  const titleKeywordPresent = titleKeywordPresence(input.keywords, input.facts.title);
  const bulletKeywordPresent = bulletKeywordPresence(input.keywords, input.facts.bullets);
  const coverage = highVolumeCoverage(input.keywords, input.facts.title, input.facts.bullets);

  return {
    IS: computeImageScore({ imageCount: input.facts.imageCount, lifestylePresent: input.lifestylePresent, qualityScore: input.qualityScore }),
    RS: computeReviewScore({ reviewCount: input.reviewCount, rating: input.rating }),
    PS: computePriceScore({ price: input.facts.price, competitorAveragePrice: input.competitorAveragePrice }),
    TS: computeTitleScore({
      titleLength: input.facts.titleLength,
      titleKeywordPresent,
      titleReadability: rubric.titleReadability,
      titleReadabilityReason: rubric.titleReadabilityReason
    }),
    BS: computeBulletScore({
      bulletCount: input.facts.bulletCount,
      bulletKeywordPresent,
      bulletClarity: rubric.bulletClarity,
      bulletClarityReason: rubric.bulletClarityReason,
      featureBenefit: rubric.featureBenefit,
      featureBenefitReason: rubric.featureBenefitReason
    }),
    KS: computeKeywordScore({ highVolumeCoverage: coverage }),
    CSF: computeCreativeScore({ hasAplus: input.hasAplus, hasVideo: input.hasVideo })
  };
}

// ---- Gap ranking (Part A Step 3) ----

const GAP_LABELS: Record<SubScoreKey, string> = {
  IS: "Image Score",
  RS: "Review Score",
  PS: "Price Score",
  TS: "Title Score",
  BS: "Bullet Score",
  KS: "Keyword Score",
  CSF: "Creative Strength (A+/Video)"
};

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function buildGaps(ownSubScores: ListingOptimizerSubScores, competitorSummary: CompetitorSummaryEntry[]): ListingOptimizerGap[] {
  const gaps: ListingOptimizerGap[] = [];

  for (const key of Object.keys(WEIGHTS) as SubScoreKey[]) {
    const own = ownSubScores[key];
    if (!own || own.value === null) continue;

    const competitorValues = competitorSummary
      .map((c) => c.subScores[key]?.value)
      .filter((v): v is number => typeof v === "number");
    const sortedDesc = [...competitorValues].sort((a, b) => b - a);
    const competitorAverage = average(competitorValues);
    const top3Average = average(sortedDesc.slice(0, 3));

    const impact = round1(WEIGHTS[key] * (100 - own.value));
    const beatenByCompetitors = competitorAverage !== null && competitorAverage > own.value;

    let actionText: string;
    if (competitorValues.length === 0) {
      actionText = `Improving ${GAP_LABELS[key]} toward 100 is worth up to ${impact} Conversion Score point(s). No confirmed competitor data yet to show whether they beat you here.`;
    } else if (beatenByCompetitors) {
      actionText = `Improving ${GAP_LABELS[key]} toward 100 is worth up to ${impact} Conversion Score point(s) -- your confirmed competitors average ${round1(competitorAverage as number)}, ahead of your ${own.value}.`;
    } else {
      actionText = `Improving ${GAP_LABELS[key]} toward 100 is worth up to ${impact} Conversion Score point(s), though your confirmed competitors average ${round1(competitorAverage as number)}, behind your ${own.value}.`;
    }

    gaps.push({
      subScore: key,
      label: GAP_LABELS[key],
      impact,
      ownValue: own.value,
      competitorAverage: competitorAverage !== null ? round1(competitorAverage) : null,
      top3Average: top3Average !== null ? round1(top3Average) : null,
      actionText
    });
  }

  return gaps.sort((a, b) => b.impact - a.impact).slice(0, 5);
}

// ---- Row <-> API shape mapping ----

function toSafeAnalysis(row: ListingOptimizerAnalysisRow): SafeListingOptimizerAnalysis {
  return {
    id: row.id,
    sellerId: row.seller_id,
    benchmarkRunId: row.benchmark_run_id,
    ownSku: row.own_sku,
    ownAsin: row.own_asin,
    brand: row.brand,
    ownReviewCount: row.own_review_count,
    ownRating: toNumberOrNull(row.own_rating),
    ownHasVideo: row.own_has_video,
    ownHasLifestyleImage: row.own_has_lifestyle_image,
    ownImageQualityScore: toNumberOrNull(row.own_image_quality_score),
    highVolumeKeywords: row.high_volume_keywords ?? [],
    subScores: row.sub_scores ?? {},
    overallScore: toNumberOrNull(row.overall_score),
    grade: row.grade,
    gaps: row.gaps ?? [],
    competitorSummary: row.competitor_summary ?? [],
    warnings: row.warnings ?? [],
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---- Main orchestration ----

async function findBenchmarkRun(sellerId: string, ownSku: string, benchmarkRunId?: string | null): Promise<CompetitorBenchmarkRunRow | null> {
  if (benchmarkRunId) {
    const { data } = await supabase
      .from("competitor_benchmark_runs")
      .select("*")
      .eq("id", benchmarkRunId)
      .eq("seller_id", sellerId)
      .maybeSingle<CompetitorBenchmarkRunRow>();
    return data ?? null;
  }

  const { data } = await supabase
    .from("competitor_benchmark_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("status", "DONE")
    .contains("own_skus", [ownSku])
    .order("created_at", { ascending: false })
    .limit(1);

  return ((data ?? [])[0] as CompetitorBenchmarkRunRow | undefined) ?? null;
}

async function findAnyBenchmarkRunForSku(sellerId: string, ownSku: string): Promise<CompetitorBenchmarkRunRow | null> {
  const { data } = await supabase
    .from("competitor_benchmark_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .contains("own_skus", [ownSku])
    .order("created_at", { ascending: false })
    .limit(1);

  return ((data ?? [])[0] as CompetitorBenchmarkRunRow | undefined) ?? null;
}

// Added 2026-10-05: before this, running an analysis for a SKU that had no Competitor Benchmark
// Tool history at all just failed with "go run that tool first" -- a separate page, a separate
// manual "Confirm" pass per candidate, a separate manual "Run comparison" click. Per the founder's
// explicit instruction ("all part/task should work automatically, not manually feeding inputs"),
// a single "Run analysis" click now drives the whole pipeline itself: create the benchmark run if
// none exists yet, auto-confirm every candidate Amazon's own catalog search already suggested
// (unless a real person already rejected it in the Competitor Benchmark Tool -- that decision is
// never overridden), and pull the real comparison data, all before scoring. The Competitor
// Benchmark Tool page itself is untouched and still useful for manually reviewing/rejecting
// specific competitor ASINs, but it is no longer a required manual step.
async function ensureAutomaticCompetitorData(input: {
  sellerId: string;
  ownSku: string;
}): Promise<{ run: CompetitorBenchmarkRunRow | null; autoActions: string[]; blockedReason: string | null }> {
  const autoActions: string[] = [];

  let run = await findAnyBenchmarkRunForSku(input.sellerId, input.ownSku);

  if (!run) {
    autoActions.push(`No Competitor Benchmark history existed yet for ${input.ownSku} -- ran competitor discovery automatically instead of asking you to do it on a separate page.`);
    const created = await createCompetitorBenchmarkRun({ sellerId: input.sellerId, skus: [input.ownSku] });
    const skipped = created.skippedSkus.find((s) => s.sku === input.ownSku);
    if (skipped) {
      return { run: null, autoActions, blockedReason: skipped.reason };
    }
    // Build the row directly from what createCompetitorBenchmarkRun just returned, instead of
    // re-querying Supabase for it. A live test on 2026-10-05 caught a real bug here: the
    // immediate re-query (findAnyBenchmarkRunForSku) came back empty even though the run row had
    // genuinely just been written (confirmed seconds later with a direct SQL check) -- a
    // read-after-write race against Supabase's API layer, not a real "could not create" failure.
    // The create call already has every field this run row needs, so there's no reason to read it
    // back at all.
    run = {
      id: created.run.id,
      seller_id: created.run.sellerId,
      own_skus: created.run.ownSkus,
      status: created.run.status,
      error_message: created.run.errorMessage,
      created_at: created.run.createdAt,
      updated_at: created.run.updatedAt,
      completed_at: created.run.completedAt
    };
  }

  const { data: candidateRows } = await supabase
    .from("competitor_benchmark_candidates")
    .select("id, asin, confirmed, source")
    .eq("run_id", run.id)
    .eq("own_sku", input.ownSku);

  const candidates = (candidateRows ?? []) as { id: string; asin: string; confirmed: boolean | null; source: string }[];
  const competitorCandidates = candidates.filter((c) => c.source !== "OWN_BASELINE");

  // Auto-confirm anything not already explicitly rejected (confirmed === false) by a real person.
  // Most candidates already default to confirmed = true at discovery time; this only catches the
  // ones still sitting at "needs review" (confirmed === null) so an automatic run never stalls
  // on a manual review step the founder didn't ask to do.
  const needsAutoConfirm = competitorCandidates.filter((c) => c.confirmed === null).map((c) => c.asin);
  if (needsAutoConfirm.length > 0) {
    autoActions.push(`Auto-confirmed ${needsAutoConfirm.length} Amazon-suggested competitor ASIN(s) for ${input.ownSku} that hadn't been reviewed yet (none had been rejected).`);
    await confirmCompetitorBenchmarkCandidates({
      runId: run.id,
      sellerId: input.sellerId,
      ownSku: input.ownSku,
      confirmedAsins: needsAutoConfirm,
      removedAsins: [],
      addedAsins: []
    });
  }

  const confirmedCompetitorCount = competitorCandidates.filter((c) => c.confirmed !== false).length;
  const candidateIds = candidates.map((c) => c.id);

  const { data: dataRows } = await supabase
    .from("competitor_benchmark_data")
    .select("candidate_id, fetch_status")
    .in("candidate_id", candidateIds.length > 0 ? candidateIds : [""]);

  const fetchStatusByCandidateId = new Map(((dataRows ?? []) as { candidate_id: string; fetch_status: string }[]).map((r) => [r.candidate_id, r.fetch_status]));

  const ownCandidate = candidates.find((c) => c.source === "OWN_BASELINE") ?? null;
  const ownFetched = ownCandidate ? fetchStatusByCandidateId.get(ownCandidate.id) === "FETCHED" : false;
  const hasFetchedConfirmedCompetitor = competitorCandidates.some((c) => c.confirmed !== false && fetchStatusByCandidateId.get(c.id) === "FETCHED");

  const needsCompare = !ownFetched || needsAutoConfirm.length > 0 || (confirmedCompetitorCount > 0 && !hasFetchedConfirmedCompetitor);

  if (needsCompare) {
    autoActions.push(`Pulled real Amazon price/image/bullet/title data automatically for ${input.ownSku} and its confirmed competitors.`);
    // Same fix as above: use the row the comparison call just returned directly, rather than
    // re-querying Supabase for it (see the comment above on the read-after-write race that caused
    // a real false "could not create" failure here on 2026-10-05).
    const compared = await runCompetitorBenchmarkComparison({ runId: run.id, sellerId: input.sellerId });
    run = {
      id: compared.id,
      seller_id: compared.sellerId,
      own_skus: compared.ownSkus,
      status: compared.status,
      error_message: compared.errorMessage,
      created_at: compared.createdAt,
      updated_at: compared.updatedAt,
      completed_at: compared.completedAt
    };
  }

  return { run, autoActions, blockedReason: null };
}

async function loadAplusStatus(sellerId: string, asin: string | null): Promise<boolean | null> {
  if (!asin) return null;
  const { data } = await supabase
    .from("amazon_aplus_content_cache")
    .select("status, content_module_list")
    .eq("seller_id", sellerId)
    .eq("asin", asin)
    .maybeSingle<{ status: string; content_module_list: unknown[] }>();

  if (!data) return null; // not checked yet -- unknown, not false
  const moduleCount = Array.isArray(data.content_module_list) ? data.content_module_list.length : 0;
  return data.status !== "NOT_FOUND" && moduleCount > 0;
}

export async function runListingOptimizerAnalysis(input: RunAnalysisInput): Promise<SafeListingOptimizerAnalysis> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const ownSku = cleanText(input.ownSku);
  if (!ownSku) throw new ListingOptimizerError("ownSku is required.");

  const warnings: string[] = [];

  const passports = await listProductPassports({ sellerId });
  const passport = passports.find((p) => p.sku === ownSku) ?? null;
  const ownAsin = passport?.asin ?? null;
  const brand = resolveBrandName({ sku: ownSku, product_name: passport?.productName ?? null });

  // A specific benchmarkRunId means the caller deliberately pinned this analysis to a past run
  // (not currently used by the frontend, but kept for API callers that want that control) -- the
  // automatic pipeline below only kicks in for the normal case, where none was given.
  let run: CompetitorBenchmarkRunRow | null;
  if (input.benchmarkRunId) {
    run = await findBenchmarkRun(sellerId, ownSku, input.benchmarkRunId);
    if (!run) {
      return persistAndReturn({
        sellerId,
        ownSku,
        ownAsin,
        brand,
        input,
        benchmarkRunId: null,
        subScores: {},
        overallScore: null,
        grade: null,
        gaps: [],
        competitorSummary: [],
        status: "FAILED",
        errorMessage: null,
        warnings: [`No Competitor Benchmark run with id ${input.benchmarkRunId} was found for SKU ${ownSku}.`]
      });
    }
  } else {
    const ensured = await ensureAutomaticCompetitorData({ sellerId, ownSku });
    warnings.push(...ensured.autoActions);
    run = ensured.run;
    if (!run) {
      return persistAndReturn({
        sellerId,
        ownSku,
        ownAsin,
        brand,
        input,
        benchmarkRunId: null,
        subScores: {},
        overallScore: null,
        grade: null,
        gaps: [],
        competitorSummary: [],
        status: "FAILED",
        errorMessage: null,
        warnings: [
          ensured.blockedReason ?? `Could not automatically gather competitor data for SKU ${ownSku}.`
        ]
      });
    }
  }

  const { data: candidateRows } = await supabase
    .from("competitor_benchmark_candidates")
    .select("*")
    .eq("run_id", run.id)
    .eq("own_sku", ownSku);

  const candidates = (candidateRows ?? []) as CompetitorBenchmarkCandidateRow[];
  const ownCandidate = candidates.find((c) => c.source === "OWN_BASELINE") ?? null;
  const competitorCandidates = candidates.filter((c) => c.source !== "OWN_BASELINE" && c.confirmed === true);

  const { data: dataRows } = await supabase
    .from("competitor_benchmark_data")
    .select("*")
    .eq("run_id", run.id)
    .in("candidate_id", candidates.map((c) => c.id).length > 0 ? candidates.map((c) => c.id) : [""]);

  const dataByCandidateId = new Map(((dataRows ?? []) as CompetitorBenchmarkDataRow[]).map((row) => [row.candidate_id, row]));
  const ownData = ownCandidate ? dataByCandidateId.get(ownCandidate.id) ?? null : null;

  if (!ownCandidate || !ownData || ownData.fetch_status !== "FETCHED") {
    warnings.push(
      `The automatic fetch of this SKU's own Amazon listing data did not succeed in run ${run.id} (${ownData?.fetch_error ?? "no data on file"}). This is usually a temporary Amazon API issue -- try "Run analysis" again in a moment; no manual step on the Competitor Benchmark Tool page is needed.`
    );
    return persistAndReturn({
      sellerId,
      ownSku,
      ownAsin,
      brand,
      input,
      benchmarkRunId: run.id,
      subScores: {},
      overallScore: null,
      grade: null,
      gaps: [],
      competitorSummary: [],
      status: "FAILED",
      errorMessage: null,
      warnings
    });
  }

  let marketplaceId: string | null = null;
  try {
    const connection = await requireConnectedConnection(sellerId);
    marketplaceId = connection.marketplace_id;
  } catch {
    warnings.push("Amazon isn't connected right now -- real title/bullet TEXT (needed for keyword matching and AI readability judging) couldn't be re-read from the last saved snapshot's payload structure. Numeric sub-scores (image count, bullet count, title length, price) are unaffected.");
  }

  const ownFacts: ListingFacts = {
    label: `own:${ownSku}`,
    price: toNumberOrNull(ownData.price),
    imageCount: ownData.image_count,
    bulletCount: ownData.bullet_count,
    titleLength: ownData.title_length,
    ...(marketplaceId ? extractTitleAndBulletsFromCatalogPayload(ownData.raw_catalog_payload, marketplaceId) : { title: null, bullets: [] })
  };

  const fetchedCompetitors = competitorCandidates
    .map((c) => ({ candidate: c, data: dataByCandidateId.get(c.id) ?? null }))
    .filter((entry): entry is { candidate: CompetitorBenchmarkCandidateRow; data: CompetitorBenchmarkDataRow } => Boolean(entry.data) && entry.data!.fetch_status === "FETCHED");

  if (fetchedCompetitors.length === 0) {
    warnings.push(
      `No confirmed-and-fetched competitors exist yet for ${ownSku} in run ${run.id}. Confirm competitors and run the comparison in the Competitor Benchmark Tool to get Price Score and gap analysis against real competitor data.`
    );
  }

  const competitorPrices = fetchedCompetitors
    .map((entry) => toNumberOrNull(entry.data.price))
    .filter((v): v is number => v !== null);
  const competitorAveragePrice = average(competitorPrices);

  const hasAplus = await loadAplusStatus(sellerId, ownAsin);
  if (hasAplus === null) {
    warnings.push("A+ Content coverage hasn't been checked for this ASIN yet -- run the A+ Content check for it to score the Creative Strength sub-score's A+ component.");
  }

  const useAiJudging = input.useAiJudging !== false;
  const aiState: AiRubricState = { calls: 0, limit: MAX_AI_RUBRIC_CALLS_PER_ANALYSIS };
  const keywords = (input.highVolumeKeywords ?? []).map((k) => cleanText(k)).filter((k): k is string => Boolean(k));

  const ownSubScores = await scoreListing({
    facts: ownFacts,
    competitorAveragePrice,
    keywords,
    hasAplus,
    hasVideo: input.ownHasVideo ?? null,
    lifestylePresent: input.ownHasLifestyleImage ?? null,
    qualityScore: input.ownImageQualityScore ?? null,
    reviewCount: input.ownReviewCount ?? null,
    rating: input.ownRating ?? null,
    useAiJudging,
    sellerId,
    aiState
  });

  if (!useAiJudging) {
    warnings.push("AI rubric judging was turned off for this run -- title readability, bullet clarity, and feature/benefit inputs were left unscored. Real/manual inputs were still used.");
  }

  const competitorSummary: CompetitorSummaryEntry[] = [];
  for (const entry of fetchedCompetitors) {
    const facts: ListingFacts = {
      label: `competitor:${entry.candidate.asin}`,
      price: toNumberOrNull(entry.data.price),
      imageCount: entry.data.image_count,
      bulletCount: entry.data.bullet_count,
      titleLength: entry.data.title_length,
      ...(marketplaceId ? extractTitleAndBulletsFromCatalogPayload(entry.data.raw_catalog_payload, marketplaceId) : { title: null, bullets: [] })
    };

    const competitorAplus = await loadAplusStatus(sellerId, entry.candidate.asin);

    const subScores = await scoreListing({
      facts,
      competitorAveragePrice,
      keywords,
      hasAplus: competitorAplus,
      // No data source exists for a competitor's own rating/review count (SP-API never exposes
      // it) or video presence (not tracked anywhere) -- always unknown, never guessed.
      hasVideo: null,
      lifestylePresent: null,
      qualityScore: null,
      reviewCount: null,
      rating: null,
      useAiJudging,
      sellerId,
      aiState
    });

    const { overallScore } = overallFromSubScores(subScores);
    competitorSummary.push({
      asin: entry.candidate.asin,
      title: entry.candidate.title,
      overallScore,
      subScores
    });
  }

  if (aiState.calls >= aiState.limit) {
    warnings.push(`This analysis hit its per-run AI rubric call cap (${aiState.limit}) -- some listings' readability/clarity/feature-benefit inputs were left unscored this run.`);
  }

  const { overallScore, grade, weightNote } = overallFromSubScores(ownSubScores);
  if (weightNote) warnings.push(weightNote);

  const gaps = buildGaps(ownSubScores, competitorSummary);

  return persistAndReturn({
    sellerId,
    ownSku,
    ownAsin,
    brand,
    input,
    benchmarkRunId: run.id,
    subScores: ownSubScores,
    overallScore,
    grade,
    gaps,
    competitorSummary,
    status: "DONE",
    errorMessage: null,
    warnings
  });
}

async function persistAndReturn(args: {
  sellerId: string;
  ownSku: string;
  ownAsin: string | null;
  brand: string;
  input: RunAnalysisInput;
  benchmarkRunId: string | null;
  subScores: ListingOptimizerSubScores;
  overallScore: number | null;
  grade: string | null;
  gaps: ListingOptimizerGap[];
  competitorSummary: CompetitorSummaryEntry[];
  status: string;
  errorMessage: string | null;
  warnings: string[];
}): Promise<SafeListingOptimizerAnalysis> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("listing_optimizer_analyses")
    .insert({
      seller_id: args.sellerId,
      benchmark_run_id: args.benchmarkRunId,
      own_sku: args.ownSku,
      own_asin: args.ownAsin,
      brand: args.brand,
      own_review_count: args.input.ownReviewCount ?? null,
      own_rating: args.input.ownRating ?? null,
      own_has_video: args.input.ownHasVideo ?? null,
      own_has_lifestyle_image: args.input.ownHasLifestyleImage ?? null,
      own_image_quality_score: args.input.ownImageQualityScore ?? null,
      high_volume_keywords: args.input.highVolumeKeywords ?? [],
      sub_scores: args.subScores,
      overall_score: args.overallScore,
      grade: args.grade,
      gaps: args.gaps,
      competitor_summary: args.competitorSummary,
      warnings: args.warnings,
      status: args.status,
      error_message: args.errorMessage,
      updated_at: now
    })
    .select("*")
    .single<ListingOptimizerAnalysisRow>();

  if (error || !data) throw new Error(error?.message ?? "Could not save the Listing Optimizer analysis to Supabase.");
  return toSafeAnalysis(data);
}

export async function getListingOptimizerAnalysis(input: { id: string; sellerId: string }): Promise<SafeListingOptimizerAnalysis | null> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const { data } = await supabase
    .from("listing_optimizer_analyses")
    .select("*")
    .eq("id", input.id)
    .eq("seller_id", sellerId)
    .maybeSingle<ListingOptimizerAnalysisRow>();
  return data ? toSafeAnalysis(data) : null;
}

export async function listListingOptimizerAnalyses(input: { sellerId: string; ownSku?: string; limit?: number }): Promise<SafeListingOptimizerAnalysis[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  let query = supabase
    .from("listing_optimizer_analyses")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.ownSku) query = query.eq("own_sku", input.ownSku);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as ListingOptimizerAnalysisRow[]).map(toSafeAnalysis);
}
