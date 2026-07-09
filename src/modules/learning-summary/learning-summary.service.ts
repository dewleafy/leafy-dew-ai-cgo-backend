import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { ExperimentRow } from "../experiments/experiments.types";
import { RecommendationOutcomeRow } from "../recommendation-outcomes/recommendation-outcomes.types";
import { AiRecommendationRow } from "../recommendations/recommendations.types";
import {
  ApprovalPattern,
  ExperimentLearningItem,
  LearningPriority,
  LearningSummaryCount,
  LearningSummaryResponse,
  NeedsMoreDataRecommendation,
  OutcomeLearningItem,
  PromisingRecommendation,
  RecommendationActionLearning,
  RecommendationTypeLearning
} from "./learning-summary.types";

type GroupAccumulator = {
  total: number;
  approved: number;
  rejected: number;
  monitoring: number;
  new: number;
  priorityScoreTotal: number;
  confidenceScoreTotal: number;
};

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

function logLearningSummaryError(context: string, error: { message?: string; code?: string }): void {
  logger.warn(context, {
    message: error.message ? sanitizeErrorMessage(error.message) : undefined,
    code: error.code ? sanitizeErrorMessage(error.code) : undefined
  });
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cutoffIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function countByStatus<T extends { status?: string | null }>(rows: T[], status: string): number {
  return rows.filter((row) => row.status === status).length;
}

function countByOutcomeStatus(rows: RecommendationOutcomeRow[], status: string): number {
  return rows.filter((row) => row.outcome_status === status).length;
}

function createEmptySummary(): LearningSummaryCount {
  return {
    recommendationCount: 0,
    newRecommendationCount: 0,
    approvedRecommendationCount: 0,
    rejectedRecommendationCount: 0,
    monitoringRecommendationCount: 0,
    completedRecommendationCount: 0,
    experimentCount: 0,
    activeExperimentCount: 0,
    completedExperimentCount: 0,
    outcomeCount: 0,
    workedCount: 0,
    failedCount: 0,
    needsMoreDataCount: 0,
    partialCount: 0
  };
}

function buildSummary(
  recommendations: AiRecommendationRow[],
  experiments: ExperimentRow[],
  outcomes: RecommendationOutcomeRow[]
): LearningSummaryCount {
  return {
    ...createEmptySummary(),
    recommendationCount: recommendations.length,
    newRecommendationCount: countByStatus(recommendations, "NEW"),
    approvedRecommendationCount: countByStatus(recommendations, "APPROVED"),
    rejectedRecommendationCount: countByStatus(recommendations, "REJECTED"),
    monitoringRecommendationCount: countByStatus(recommendations, "MONITORING"),
    completedRecommendationCount: countByStatus(recommendations, "COMPLETED_MANUALLY"),
    experimentCount: experiments.length,
    activeExperimentCount: countByStatus(experiments, "ACTIVE"),
    completedExperimentCount: countByStatus(experiments, "COMPLETED"),
    outcomeCount: outcomes.length,
    workedCount: countByOutcomeStatus(outcomes, "WORKED"),
    failedCount: countByOutcomeStatus(outcomes, "FAILED"),
    needsMoreDataCount: countByOutcomeStatus(outcomes, "NEEDS_MORE_DATA"),
    partialCount: countByOutcomeStatus(outcomes, "PARTIAL")
  };
}

function addRecommendationToGroup(group: GroupAccumulator, row: AiRecommendationRow): void {
  group.total += 1;
  if (row.status === "APPROVED") group.approved += 1;
  if (row.status === "REJECTED") group.rejected += 1;
  if (row.status === "MONITORING") group.monitoring += 1;
  if (row.status === "NEW") group.new += 1;
  group.priorityScoreTotal += toNumber(row.priority_score);
  group.confidenceScoreTotal += toNumber(row.confidence_score);
}

function buildByType(recommendations: AiRecommendationRow[]): RecommendationTypeLearning[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const row of recommendations) {
    const key = row.recommendation_type || "UNKNOWN";
    const group = groups.get(key) ?? {
      total: 0,
      approved: 0,
      rejected: 0,
      monitoring: 0,
      new: 0,
      priorityScoreTotal: 0,
      confidenceScoreTotal: 0
    };
    addRecommendationToGroup(group, row);
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .map(([recommendationType, group]) => ({
      recommendationType,
      total: group.total,
      approved: group.approved,
      rejected: group.rejected,
      monitoring: group.monitoring,
      new: group.new,
      averagePriorityScore: group.total > 0 ? round2(group.priorityScoreTotal / group.total) : 0,
      averageConfidenceScore: group.total > 0 ? round2(group.confidenceScoreTotal / group.total) : 0
    }))
    .sort((a, b) => b.total - a.total);
}

function buildByAction(recommendations: AiRecommendationRow[]): RecommendationActionLearning[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const row of recommendations) {
    const key = row.recommended_action || "UNKNOWN";
    const group = groups.get(key) ?? {
      total: 0,
      approved: 0,
      rejected: 0,
      monitoring: 0,
      new: 0,
      priorityScoreTotal: 0,
      confidenceScoreTotal: 0
    };
    addRecommendationToGroup(group, row);
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .map(([recommendedAction, group]) => ({
      recommendedAction,
      total: group.total,
      approved: group.approved,
      rejected: group.rejected,
      monitoring: group.monitoring,
      new: group.new
    }))
    .sort((a, b) => b.total - a.total);
}

function buildApprovalPattern(summary: LearningSummaryCount): ApprovalPattern {
  const total = summary.recommendationCount;

  if (total === 0) {
    return {
      approvalRate: 0,
      rejectionRate: 0,
      monitoringRate: 0,
      message: "No recommendation decisions yet."
    };
  }

  let message = "Recommendation decisions are balanced enough to keep collecting learning signals.";
  if (summary.approvedRecommendationCount > 0 && summary.rejectedRecommendationCount === 0) {
    message = "Founder is currently approving cautiously without rejection history.";
  }
  if (summary.monitoringRecommendationCount > summary.approvedRecommendationCount) {
    message = "Founder is preferring monitoring until more data is available.";
  }

  return {
    approvalRate: round2((summary.approvedRecommendationCount / total) * 100),
    rejectionRate: round2((summary.rejectedRecommendationCount / total) * 100),
    monitoringRate: round2((summary.monitoringRecommendationCount / total) * 100),
    message
  };
}

function buildTopPromisingRecommendations(recommendations: AiRecommendationRow[]): PromisingRecommendation[] {
  return recommendations
    .filter((row) => (row.status === "APPROVED" || row.status === "NEW") && ["LOW", "MEDIUM"].includes(row.risk_level ?? "LOW"))
    .sort((a, b) => toNumber(b.priority_score) - toNumber(a.priority_score))
    .slice(0, 5)
    .map((row) => ({
      id: row.id,
      recommendationType: row.recommendation_type,
      recommendedAction: row.recommended_action,
      entityValue: row.entity_value,
      status: row.status ?? "NEW",
      priorityLabel: row.priority_label ?? "LOW",
      confidenceLabel: row.confidence_label ?? "LOW",
      riskLevel: row.risk_level ?? "LOW",
      reason: row.reason
    }));
}

function buildNeedsMoreDataRecommendations(outcomes: RecommendationOutcomeRow[]): NeedsMoreDataRecommendation[] {
  return outcomes
    .filter((row) => row.outcome_status === "NEEDS_MORE_DATA")
    .slice(0, 5)
    .map((row) => ({
      recommendationId: row.recommendation_id,
      outcomeId: row.id,
      resultSummary: row.result_summary,
      learningNote: row.learning_note,
      evaluationWindowDays: row.evaluation_window_days
    }));
}

function buildRiskyPatterns(summary: LearningSummaryCount): string[] {
  const messages: string[] = [];

  if (summary.newRecommendationCount >= 5) {
    messages.push("There are pending recommendations waiting for decision.");
  }
  if (summary.needsMoreDataCount >= 3) {
    messages.push("Several recommendations need more data before confidence can improve.");
  }
  if (summary.rejectedRecommendationCount > summary.approvedRecommendationCount) {
    messages.push("Many recommendations are being rejected; rule quality may need review.");
  }
  if (summary.failedCount > 0) {
    messages.push("Some recommendations failed and should reduce confidence for similar future actions.");
  }

  return messages;
}

function toExperimentLearningItem(row: ExperimentRow): ExperimentLearningItem {
  return {
    id: row.id,
    experimentName: row.experiment_name ?? row.name ?? "Untitled experiment",
    experimentType: row.experiment_type,
    status: row.status,
    priority: row.priority ?? "MEDIUM",
    hypothesis: row.hypothesis,
    expectedResult: row.expected_result ?? row.description ?? null,
    successMetric: row.success_metric ?? null,
    startDate: row.start_date ?? row.started_at ?? null,
    endDate: row.end_date ?? row.ended_at ?? null
  };
}

function toOutcomeLearningItem(row: RecommendationOutcomeRow): OutcomeLearningItem {
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    experimentId: row.experiment_id,
    outcomeStatus: row.outcome_status,
    resultSummary: row.result_summary,
    learningNote: row.learning_note,
    profitImpact: toNumberOrNull(row.profit_impact),
    salesImpact: toNumberOrNull(row.sales_impact),
    costImpact: toNumberOrNull(row.cost_impact),
    acosBefore: toNumberOrNull(row.acos_before),
    acosAfter: toNumberOrNull(row.acos_after),
    ordersBefore: toNumberOrNull(row.orders_before),
    ordersAfter: toNumberOrNull(row.orders_after)
  };
}

function buildSystemInsights(summary: LearningSummaryCount, recommendations: AiRecommendationRow[], experiments: ExperimentRow[]): string[] {
  const insights: string[] = [];

  if (recommendations.some((row) => row.recommendation_type.toLowerCase().includes("keyword"))) {
    insights.push("The system has started learning from PPC keyword recommendations.");
  }
  if (summary.approvedRecommendationCount > 0 && summary.needsMoreDataCount > 0) {
    insights.push("The approved exact keyword recommendation still needs more post-approval data.");
  }
  if (summary.outcomeCount < Math.max(1, Math.floor(summary.recommendationCount / 3))) {
    insights.push("More outcomes are needed before the system can confidently adjust future rule scores.");
  }
  if (experiments.some((row) => row.status === "ACTIVE")) {
    insights.push("Active experiments should be reviewed after their evaluation window.");
  }
  if (insights.length === 0) {
    insights.push("Learning data is quiet right now; keep saving outcomes as decisions mature.");
  }

  return insights;
}

function buildNextBestAction(summary: LearningSummaryCount, plannedExperimentCount: number): {
  title: string;
  reason: string;
  priority: LearningPriority;
} {
  if (summary.activeExperimentCount > 0 && summary.needsMoreDataCount > 0) {
    return {
      title: "Wait for experiment data",
      reason: "There are active experiments and outcomes that need more data before evaluation.",
      priority: "LOW"
    };
  }
  if (summary.newRecommendationCount > 0) {
    return {
      title: "Review pending recommendations",
      reason: "There are new recommendations waiting for approve, reject, or monitor decision.",
      priority: "HIGH"
    };
  }
  if (plannedExperimentCount > 0) {
    return {
      title: "Start planned experiments",
      reason: "There are planned experiments ready to begin.",
      priority: "MEDIUM"
    };
  }
  if (summary.outcomeCount === 0) {
    return {
      title: "Add recommendation outcomes",
      reason: "The system needs outcomes to start learning.",
      priority: "HIGH"
    };
  }

  return {
    title: "Continue monitoring learning signals",
    reason: "Learning data exists and should be reviewed after more days.",
    priority: "LOW"
  };
}

function buildWarnings(summary: LearningSummaryCount): string[] {
  const warnings: string[] = [];

  if (summary.recommendationCount === 0) {
    warnings.push("No recommendations were found for this period.");
  }
  if (summary.outcomeCount === 0) {
    warnings.push("No outcomes were found yet, so learning confidence is limited.");
  }

  return warnings;
}

async function loadRows<T>(table: string, sellerId: string, sinceIso: string): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("seller_id", sellerId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    logLearningSummaryError(`Could not load ${table} for learning summary.`, error);
    throw new Error(`Could not load ${table} from Supabase.`);
  }

  return (data ?? []) as T[];
}

export async function buildLearningSummary(input: {
  sellerId: string;
  days: number;
}): Promise<LearningSummaryResponse> {
  const sellerId = input.sellerId.trim() || "default";
  const days = Math.min(Math.max(Math.floor(input.days), 1), 90);
  const sinceIso = cutoffIso(days);

  const [recommendations, experiments, outcomes] = await Promise.all([
    loadRows<AiRecommendationRow>("ai_recommendations", sellerId, sinceIso),
    loadRows<ExperimentRow>("experiments", sellerId, sinceIso),
    loadRows<RecommendationOutcomeRow>("recommendation_outcomes", sellerId, sinceIso)
  ]);

  const summary = buildSummary(recommendations, experiments, outcomes);
  const activeExperiments = experiments.filter((row) => row.status === "ACTIVE" || row.status === "RUNNING").slice(0, 5).map(toExperimentLearningItem);
  const completedExperiments = experiments.filter((row) => row.status === "COMPLETED").slice(0, 5).map(toExperimentLearningItem);
  const plannedExperiments = experiments.filter((row) => row.status === "PLANNED" || row.status === "DRAFT").slice(0, 5).map(toExperimentLearningItem);

  return {
    ok: true,
    sellerId,
    days,
    mode: "LEARNING_SUMMARY_V1",
    summary,
    recommendationLearning: {
      byType: buildByType(recommendations),
      byAction: buildByAction(recommendations),
      approvalPattern: buildApprovalPattern(summary),
      topPromisingRecommendations: buildTopPromisingRecommendations(recommendations),
      needsMoreDataRecommendations: buildNeedsMoreDataRecommendations(outcomes),
      riskyPatterns: buildRiskyPatterns(summary)
    },
    experimentLearning: {
      activeExperiments,
      completedExperiments,
      plannedExperiments
    },
    outcomeLearning: {
      worked: outcomes.filter((row) => row.outcome_status === "WORKED").map(toOutcomeLearningItem),
      failed: outcomes.filter((row) => row.outcome_status === "FAILED").map(toOutcomeLearningItem),
      needsMoreData: outcomes.filter((row) => row.outcome_status === "NEEDS_MORE_DATA").map(toOutcomeLearningItem),
      partial: outcomes.filter((row) => row.outcome_status === "PARTIAL").map(toOutcomeLearningItem)
    },
    systemInsights: buildSystemInsights(summary, recommendations, experiments),
    nextBestAction: buildNextBestAction(summary, plannedExperiments.length),
    warnings: buildWarnings(summary)
  };
}
