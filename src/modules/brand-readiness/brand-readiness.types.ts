export type BrandReadinessStatus = "STRONG" | "NEEDS_WORK" | "WEAK";
export type BrandReadinessPriority = "LOW" | "MEDIUM" | "HIGH";

export type BrandReadinessSection = {
  score: number;
  status: BrandReadinessStatus;
  gaps: string[];
  warnings: string[];
};

export type BrandReadinessNextBestAction = {
  title: string;
  reason: string;
  priority: BrandReadinessPriority;
};

export type BrandReadinessSummary = {
  productCount: number;
  activeProductCount: number;
  draftProductCount: number;
  missingBrandPositioningCount: number;
  missingImagesCount: number;
  bundleCandidateCount: number;
};

export type BrandReadinessBrandResult = {
  brandName: string;
  overallScore: number;
  readinessStatus: BrandReadinessStatus;
  sections: Record<string, BrandReadinessSection>;
  summary: BrandReadinessSummary;
  topBrandGaps: string[];
  recommendedActions: string[];
  bundleIdeas: string[];
  socialContentIdeas: string[];
  nextBestAction: BrandReadinessNextBestAction;
  warnings: string[];
};

export type BrandReadinessResponse = {
  ok: true;
  sellerId: string;
  mode: "BRAND_READINESS_V1";
  brands: BrandReadinessBrandResult[];
  brandDetectionNote: string;
};
