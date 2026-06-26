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
