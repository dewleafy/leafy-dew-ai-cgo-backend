// Listing Optimizer: Scoring + Gap Analysis (Part A Steps 2-3 of
// claude/listing-optimizer-image-studio-spec.md). Text generation (Step 4) and image generation
// (Step 5+) are later phases -- this module only scores listings and ranks gaps.

export type SubScoreKey = "IS" | "RS" | "PS" | "TS" | "BS" | "KS" | "CSF";

// 'computed'  -- every input the formula needs is a real or AI-judged value.
// 'partial'   -- some inputs are real/judged, some are missing; the value is a floor, not the
//                true score (missing inputs contribute 0, never an invented guess).
// 'unknown'   -- no input at all could be found or judged; excluded from the overall Conversion
//                Score (its weight is redistributed across the sub-scores that ARE available),
//                exactly like the existing Competitor Benchmark Tool excludes "unknown" Review
//                Score from its competitor average instead of scoring it 0.
export type SubScoreStatus = "computed" | "partial" | "unknown";

export type SubScoreResult = {
  value: number | null;
  status: SubScoreStatus;
  // Each formula input this sub-score depends on, and how it was obtained.
  inputs: Record<string, SubScoreInput>;
  notes: string[];
};

export type SubScoreInputSource = "real_data" | "ai_judged" | "manual_entry" | "missing";

export type SubScoreInput = {
  value: number | null;
  source: SubScoreInputSource;
  reason: string | null;
};

export type ListingOptimizerSubScores = Partial<Record<SubScoreKey, SubScoreResult>>;

export type ListingOptimizerGap = {
  subScore: SubScoreKey;
  label: string;
  impact: number;
  ownValue: number | null;
  competitorAverage: number | null;
  top3Average: number | null;
  actionText: string;
};

export type CompetitorSummaryEntry = {
  asin: string;
  title: string | null;
  overallScore: number | null;
  subScores: ListingOptimizerSubScores;
};

export type ListingOptimizerAnalysisRow = {
  id: string;
  seller_id: string;
  benchmark_run_id: string | null;
  own_sku: string;
  own_asin: string | null;
  brand: string;
  own_review_count: number | null;
  own_rating: number | string | null;
  own_has_video: boolean | null;
  own_has_lifestyle_image: boolean | null;
  own_image_quality_score: number | string | null;
  high_volume_keywords: string[];
  sub_scores: ListingOptimizerSubScores;
  overall_score: number | string | null;
  grade: string | null;
  gaps: ListingOptimizerGap[];
  competitor_summary: CompetitorSummaryEntry[];
  warnings: string[];
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeListingOptimizerAnalysis = {
  id: string;
  sellerId: string;
  benchmarkRunId: string | null;
  ownSku: string;
  ownAsin: string | null;
  brand: string;
  ownReviewCount: number | null;
  ownRating: number | null;
  ownHasVideo: boolean | null;
  ownHasLifestyleImage: boolean | null;
  ownImageQualityScore: number | null;
  highVolumeKeywords: string[];
  subScores: ListingOptimizerSubScores;
  overallScore: number | null;
  grade: string | null;
  gaps: ListingOptimizerGap[];
  competitorSummary: CompetitorSummaryEntry[];
  warnings: string[];
  status: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunAnalysisInput = {
  sellerId: string;
  ownSku: string;
  benchmarkRunId?: string | null;
  ownReviewCount?: number | null;
  ownRating?: number | null;
  ownHasVideo?: boolean | null;
  // No automated or AI source exists for these two anywhere in this app -- judging whether a
  // photo is a genuine lifestyle shot, or meets the white-background/sharp/framing bar, needs a
  // human look (or a vision-capable model, which is Step 5/6 image-pipeline territory, not built
  // yet). Left null (unknown) until the founder answers them here.
  ownHasLifestyleImage?: boolean | null;
  ownImageQualityScore?: number | null;
  highVolumeKeywords?: string[];
  useAiJudging?: boolean;
};
