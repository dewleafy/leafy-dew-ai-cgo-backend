export type LearningPriority = "LOW" | "MEDIUM" | "HIGH";

export type LearningSummaryCount = {
  recommendationCount: number;
  newRecommendationCount: number;
  approvedRecommendationCount: number;
  rejectedRecommendationCount: number;
  monitoringRecommendationCount: number;
  completedRecommendationCount: number;
  experimentCount: number;
  activeExperimentCount: number;
  completedExperimentCount: number;
  outcomeCount: number;
  workedCount: number;
  failedCount: number;
  needsMoreDataCount: number;
  partialCount: number;
};

export type RecommendationTypeLearning = {
  recommendationType: string;
  total: number;
  approved: number;
  rejected: number;
  monitoring: number;
  new: number;
  averagePriorityScore: number;
  averageConfidenceScore: number;
};

export type RecommendationActionLearning = {
  recommendedAction: string;
  total: number;
  approved: number;
  rejected: number;
  monitoring: number;
  new: number;
};

export type ApprovalPattern = {
  approvalRate: number;
  rejectionRate: number;
  monitoringRate: number;
  message: string;
};

export type PromisingRecommendation = {
  id: string;
  recommendationType: string;
  recommendedAction: string;
  entityValue: string | null;
  status: string;
  priorityLabel: string;
  confidenceLabel: string;
  riskLevel: string;
  reason: string;
};

export type NeedsMoreDataRecommendation = {
  recommendationId: string;
  outcomeId: string;
  resultSummary: string | null;
  learningNote: string | null;
  evaluationWindowDays: number;
};

export type ExperimentLearningItem = {
  id: string;
  experimentName: string;
  experimentType: string;
  status: string;
  priority: string;
  hypothesis: string | null;
  expectedResult: string | null;
  successMetric: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type OutcomeLearningItem = {
  id: string;
  recommendationId: string;
  experimentId: string | null;
  outcomeStatus: string;
  resultSummary: string | null;
  learningNote: string | null;
  profitImpact: number | null;
  salesImpact: number | null;
  costImpact: number | null;
  acosBefore: number | null;
  acosAfter: number | null;
  ordersBefore: number | null;
  ordersAfter: number | null;
};

export type LearningSummaryResponse = {
  ok: true;
  sellerId: string;
  days: number;
  mode: "LEARNING_SUMMARY_V1";
  summary: LearningSummaryCount;
  recommendationLearning: {
    byType: RecommendationTypeLearning[];
    byAction: RecommendationActionLearning[];
    approvalPattern: ApprovalPattern;
    topPromisingRecommendations: PromisingRecommendation[];
    needsMoreDataRecommendations: NeedsMoreDataRecommendation[];
    riskyPatterns: string[];
  };
  experimentLearning: {
    activeExperiments: ExperimentLearningItem[];
    completedExperiments: ExperimentLearningItem[];
    plannedExperiments: ExperimentLearningItem[];
  };
  outcomeLearning: {
    worked: OutcomeLearningItem[];
    failed: OutcomeLearningItem[];
    needsMoreData: OutcomeLearningItem[];
    partial: OutcomeLearningItem[];
  };
  systemInsights: string[];
  nextBestAction: {
    title: string;
    reason: string;
    priority: LearningPriority;
  };
  warnings: string[];
};
