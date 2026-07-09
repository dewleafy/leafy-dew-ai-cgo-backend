import { supabase } from "../../db/supabase";
import { getActionLedgerSummary } from "../action-ledger/action-ledger.service";
import { AlertCandidate, AlertEventRow, AlertRuleRow, SafeAlertEvent, SafeAlertRule } from "./alert-center.types";

const DEFAULT_ALERT_RULES: Array<Omit<AlertRuleRow, "id" | "created_at" | "updated_at">> = [
  { seller_id: "default", rule_key: "HIGH_PENDING_APPROVALS", rule_name: "High pending approvals", category: "APPROVALS", severity: "HIGH", enabled: true, condition_config: { threshold: 10 }, cooldown_hours: 24 },
  { seller_id: "default", rule_key: "COST_DATA_INCOMPLETE", rule_name: "Cost data incomplete", category: "ECONOMICS", severity: "HIGH", enabled: true, condition_config: {}, cooldown_hours: 24 },
  { seller_id: "default", rule_key: "PRODUCT_ECONOMICS_BLOCKED", rule_name: "Product economics blocked", category: "ECONOMICS", severity: "HIGH", enabled: true, condition_config: {}, cooldown_hours: 24 },
  { seller_id: "default", rule_key: "PPC_ACOS_HIGH", rule_name: "PPC ACOS high", category: "PPC", severity: "MEDIUM", enabled: true, condition_config: {}, cooldown_hours: 24 },
  { seller_id: "default", rule_key: "ENGINE_FAILURES", rule_name: "Engine failures", category: "ENGINES", severity: "HIGH", enabled: true, condition_config: {}, cooldown_hours: 12 },
  { seller_id: "default", rule_key: "LIVE_EXECUTION_ATTEMPT_BLOCKED", rule_name: "Live execution attempt blocked", category: "SAFETY", severity: "CRITICAL", enabled: true, condition_config: {}, cooldown_hours: 1 },
  { seller_id: "default", rule_key: "DATA_STALE", rule_name: "Data stale", category: "DATA", severity: "HIGH", enabled: true, condition_config: {}, cooldown_hours: 12 },
  { seller_id: "default", rule_key: "HIGH_RISK_ACTION_PENDING", rule_name: "High risk action pending", category: "APPROVALS", severity: "HIGH", enabled: true, condition_config: {}, cooldown_hours: 12 },
  { seller_id: "default", rule_key: "LEARNING_ENGINE_WEAK", rule_name: "Learning engine weak", category: "LEARNING", severity: "MEDIUM", enabled: true, condition_config: { usefulnessBelow: 35 }, cooldown_hours: 24 },
  { seller_id: "default", rule_key: "LISTING_DRAFTS_WAITING", rule_name: "Listing drafts waiting", category: "LISTING", severity: "MEDIUM", enabled: true, condition_config: {}, cooldown_hours: 24 },
  { seller_id: "default", rule_key: "CREATIVE_RECOMMENDATIONS_WAITING", rule_name: "Creative recommendations waiting", category: "CREATIVE", severity: "MEDIUM", enabled: true, condition_config: {}, cooldown_hours: 24 }
];

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toSafeRule(row: AlertRuleRow): SafeAlertRule {
  return {
    id: row.id,
    sellerId: row.seller_id,
    ruleKey: row.rule_key,
    ruleName: row.rule_name,
    category: row.category,
    severity: row.severity,
    enabled: row.enabled,
    conditionConfig: toJsonObject(row.condition_config),
    cooldownHours: row.cooldown_hours,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toSafeEvent(row: AlertEventRow): SafeAlertEvent {
  return {
    id: row.id,
    sellerId: row.seller_id,
    ruleKey: row.rule_key,
    category: row.category,
    severity: row.severity,
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sku: row.sku,
    asin: row.asin,
    actionId: row.action_id,
    status: row.status,
    source: row.source,
    metadata: toJsonObject(row.metadata),
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at
  };
}

async function safeCount(input: {
  table: string;
  sellerId?: string;
  filters?: Array<{ column: string; value: string | number | boolean }>;
  sinceColumn?: string;
  sinceIso?: string;
}): Promise<number> {
  let query = supabase.from(input.table).select("id", { count: "exact", head: true });
  if (input.sellerId) query = query.eq("seller_id", input.sellerId);
  for (const filter of input.filters ?? []) query = query.eq(filter.column, filter.value);
  if (input.sinceColumn && input.sinceIso) query = query.gte(input.sinceColumn, input.sinceIso);
  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

async function listEnabledRules(sellerId: string): Promise<SafeAlertRule[]> {
  const { data, error } = await supabase
    .from("alert_rules")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("enabled", true);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AlertRuleRow[]).map(toSafeRule);
}

export async function seedDefaultAlertRules(sellerIdInput: string): Promise<{ sellerId: string; count: number; rows: SafeAlertRule[] }> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const rows = DEFAULT_ALERT_RULES.map((rule) => ({
    ...rule,
    seller_id: sellerId,
    updated_at: new Date().toISOString()
  }));
  const { data, error } = await supabase
    .from("alert_rules")
    .upsert(rows, { onConflict: "seller_id,rule_key" })
    .select("*");
  if (error) throw new Error(error.message);
  return { sellerId, count: data?.length ?? 0, rows: ((data ?? []) as AlertRuleRow[]).map(toSafeRule) };
}

export async function listAlertEvents(input: { sellerId: string; limit: number }): Promise<SafeAlertEvent[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
  const { data, error } = await supabase
    .from("alert_events")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AlertEventRow[]).map(toSafeEvent);
}

async function openAlertDuplicateExists(candidate: AlertCandidate, sellerId: string): Promise<boolean> {
  let query = supabase
    .from("alert_events")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .eq("rule_key", candidate.ruleKey)
    .eq("status", "OPEN");

  const entityId = cleanText(candidate.entityId);
  const sku = cleanText(candidate.sku);
  const asin = cleanText(candidate.asin);
  query = entityId ? query.eq("entity_id", entityId) : query.is("entity_id", null);
  query = sku ? query.eq("sku", sku) : query.is("sku", null);
  query = asin ? query.eq("asin", asin) : query.is("asin", null);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function insertAlertEvent(candidate: AlertCandidate, sellerId: string): Promise<SafeAlertEvent> {
  const { data, error } = await supabase
    .from("alert_events")
    .insert({
      seller_id: sellerId,
      rule_key: candidate.ruleKey,
      category: candidate.category,
      severity: candidate.severity,
      title: candidate.title,
      message: candidate.message,
      entity_type: cleanText(candidate.entityType),
      entity_id: cleanText(candidate.entityId),
      sku: cleanText(candidate.sku),
      asin: cleanText(candidate.asin),
      action_id: cleanText(candidate.actionId),
      status: "OPEN",
      source: "ALERT_CENTER",
      metadata: candidate.metadata ?? {}
    })
    .select("*")
    .single<AlertEventRow>();
  if (error || !data) throw new Error(error?.message ?? "Could not create alert event.");
  return toSafeEvent(data);
}

function isRuleEnabled(enabledRules: SafeAlertRule[], ruleKey: string): boolean {
  return enabledRules.some((rule) => rule.ruleKey === ruleKey);
}

async function buildAlertCandidates(sellerId: string, enabledRules: SafeAlertRule[]): Promise<AlertCandidate[]> {
  const candidates: AlertCandidate[] = [];
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const actionSummary = await getActionLedgerSummary(sellerId).catch(() => null);

  if (isRuleEnabled(enabledRules, "HIGH_PENDING_APPROVALS") && (actionSummary?.pendingCount ?? 0) > 10) {
    candidates.push({
      ruleKey: "HIGH_PENDING_APPROVALS",
      category: "APPROVALS",
      severity: "HIGH",
      title: "Pending approvals are building up",
      message: `${actionSummary?.pendingCount ?? 0} actions are waiting for approval.`,
      metadata: { pendingCount: actionSummary?.pendingCount ?? 0 }
    });
  }

  const costDataIncomplete = await safeCount({ table: "action_ledger", sellerId, filters: [{ column: "action_type", value: "COST_DATA_REQUIRED" }, { column: "approval_status", value: "PENDING" }] });
  if (isRuleEnabled(enabledRules, "COST_DATA_INCOMPLETE") && costDataIncomplete > 0) {
    candidates.push({ ruleKey: "COST_DATA_INCOMPLETE", category: "ECONOMICS", severity: "HIGH", title: "Cost data needs completion", message: `${costDataIncomplete} cost data actions are pending.`, metadata: { costDataIncomplete } });
  }

  const economicsBlocked = await safeCount({ table: "action_ledger", sellerId, filters: [{ column: "action_type", value: "PROFIT_RISK_REVIEW" }, { column: "approval_status", value: "PENDING" }] });
  if (isRuleEnabled(enabledRules, "PRODUCT_ECONOMICS_BLOCKED") && economicsBlocked > 0) {
    candidates.push({ ruleKey: "PRODUCT_ECONOMICS_BLOCKED", category: "ECONOMICS", severity: "HIGH", title: "Product economics review is blocked", message: `${economicsBlocked} profit risk actions need review.`, metadata: { economicsBlocked } });
  }

  const ppcPending = await safeCount({ table: "action_ledger", sellerId, filters: [{ column: "action_type", value: "PPC_GUARDRAIL_REVIEW" }, { column: "approval_status", value: "PENDING" }] });
  if (isRuleEnabled(enabledRules, "PPC_ACOS_HIGH") && ppcPending > 0) {
    candidates.push({ ruleKey: "PPC_ACOS_HIGH", category: "PPC", severity: "MEDIUM", title: "PPC guardrail reviews are waiting", message: `${ppcPending} PPC guardrail actions need review.`, metadata: { ppcPending } });
  }

  const engineFailures = await safeCount({ table: "engine_run_logs", sellerId, filters: [{ column: "run_status", value: "FAILED" }], sinceColumn: "started_at", sinceIso: since24h });
  if (isRuleEnabled(enabledRules, "ENGINE_FAILURES") && engineFailures > 0) {
    candidates.push({ ruleKey: "ENGINE_FAILURES", category: "ENGINES", severity: "HIGH", title: "Engine failures detected", message: `${engineFailures} engine runs failed in the last 24 hours.`, metadata: { engineFailures, window: "24h" } });
  }

  const blockedLiveAttempts = await safeCount({ table: "execution_attempts", sellerId, filters: [{ column: "execution_status", value: "LIVE_BLOCKED" }], sinceColumn: "created_at", sinceIso: since24h });
  if (isRuleEnabled(enabledRules, "LIVE_EXECUTION_ATTEMPT_BLOCKED") && blockedLiveAttempts > 0) {
    candidates.push({ ruleKey: "LIVE_EXECUTION_ATTEMPT_BLOCKED", category: "SAFETY", severity: "CRITICAL", title: "Live execution attempt was blocked", message: `${blockedLiveAttempts} live execution attempts were blocked in the last 24 hours.`, metadata: { blockedLiveAttempts, externalExecution: false } });
  }

  const staleSources = await safeCount({ table: "data_freshness_status", sellerId, filters: [{ column: "status", value: "STALE" }] });
  if (isRuleEnabled(enabledRules, "DATA_STALE") && staleSources > 0) {
    candidates.push({ ruleKey: "DATA_STALE", category: "DATA", severity: "HIGH", title: "Data freshness warnings exist", message: `${staleSources} data sources are stale.`, metadata: { staleSources } });
  }

  if (isRuleEnabled(enabledRules, "HIGH_RISK_ACTION_PENDING") && (actionSummary?.highRiskCount ?? 0) > 0) {
    candidates.push({ ruleKey: "HIGH_RISK_ACTION_PENDING", category: "APPROVALS", severity: "HIGH", title: "High-risk actions are pending", message: `${actionSummary?.highRiskCount ?? 0} high-risk action ledger items exist.`, metadata: { highRiskCount: actionSummary?.highRiskCount ?? 0 } });
  }

  const { data: weakLearningRows } = await supabase
    .from("engine_learning_summary")
    .select("id")
    .eq("seller_id", sellerId)
    .lt("usefulness_score", 35)
    .limit(50);
  if (isRuleEnabled(enabledRules, "LEARNING_ENGINE_WEAK") && (weakLearningRows?.length ?? 0) > 0) {
    candidates.push({ ruleKey: "LEARNING_ENGINE_WEAK", category: "LEARNING", severity: "MEDIUM", title: "Some engines have weak learning scores", message: `${weakLearningRows?.length ?? 0} engines are below usefulness score 35.`, metadata: { weakLearningEngines: weakLearningRows?.length ?? 0 } });
  }

  const listingDraftsWaiting = await safeCount({ table: "listing_optimization_drafts", sellerId, filters: [{ column: "status", value: "DRAFTED" }] });
  if (isRuleEnabled(enabledRules, "LISTING_DRAFTS_WAITING") && listingDraftsWaiting > 0) {
    candidates.push({ ruleKey: "LISTING_DRAFTS_WAITING", category: "LISTING", severity: "MEDIUM", title: "Listing drafts are waiting", message: `${listingDraftsWaiting} listing optimization drafts are waiting for review.`, metadata: { listingDraftsWaiting } });
  }

  const creativeWaiting = await safeCount({ table: "creative_recommendations", sellerId, filters: [{ column: "status", value: "DRAFTED" }] });
  if (isRuleEnabled(enabledRules, "CREATIVE_RECOMMENDATIONS_WAITING") && creativeWaiting > 0) {
    candidates.push({ ruleKey: "CREATIVE_RECOMMENDATIONS_WAITING", category: "CREATIVE", severity: "MEDIUM", title: "Creative recommendations are waiting", message: `${creativeWaiting} image or A+ recommendations are waiting for review.`, metadata: { creativeWaiting } });
  }

  return candidates;
}

export async function generateAlerts(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  generatedCount: number;
  skippedCount: number;
  rows: SafeAlertEvent[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  await seedDefaultAlertRules(sellerId);
  const enabledRules = await listEnabledRules(sellerId);
  const candidates = await buildAlertCandidates(sellerId, enabledRules);
  const rows: SafeAlertEvent[] = [];
  let skippedCount = 0;

  for (const candidate of candidates) {
    if (await openAlertDuplicateExists(candidate, sellerId)) {
      skippedCount += 1;
      continue;
    }
    rows.push(await insertAlertEvent(candidate, sellerId));
  }

  return { ok: true, sellerId, generatedCount: rows.length, skippedCount, rows };
}

export async function getAlertSummary(sellerIdInput: string): Promise<{
  ok: true;
  sellerId: string;
  openAlerts: number;
  highAlerts: number;
  criticalAlerts: number;
  acknowledgedAlerts: number;
  resolvedAlerts: number;
  latestOpenAlerts: SafeAlertEvent[];
}> {
  const sellerId = cleanText(sellerIdInput) ?? "default";
  const [openAlerts, highAlerts, criticalAlerts, acknowledgedAlerts, resolvedAlerts, latestOpenAlerts] = await Promise.all([
    safeCount({ table: "alert_events", sellerId, filters: [{ column: "status", value: "OPEN" }] }),
    safeCount({ table: "alert_events", sellerId, filters: [{ column: "status", value: "OPEN" }, { column: "severity", value: "HIGH" }] }),
    safeCount({ table: "alert_events", sellerId, filters: [{ column: "status", value: "OPEN" }, { column: "severity", value: "CRITICAL" }] }),
    safeCount({ table: "alert_events", sellerId, filters: [{ column: "status", value: "ACKNOWLEDGED" }] }),
    safeCount({ table: "alert_events", sellerId, filters: [{ column: "status", value: "RESOLVED" }] }),
    listAlertEvents({ sellerId, limit: 10 }).then((rows) => rows.filter((row) => row.status === "OPEN"))
  ]);

  return { ok: true, sellerId, openAlerts, highAlerts, criticalAlerts, acknowledgedAlerts, resolvedAlerts, latestOpenAlerts };
}

export async function updateAlertEventStatus(input: {
  id: string;
  status: "ACKNOWLEDGED" | "RESOLVED";
}): Promise<SafeAlertEvent | null> {
  const now = new Date().toISOString();
  const updateRow: Record<string, unknown> = {
    status: input.status
  };
  if (input.status === "ACKNOWLEDGED") updateRow.acknowledged_at = now;
  if (input.status === "RESOLVED") updateRow.resolved_at = now;

  const { data, error } = await supabase
    .from("alert_events")
    .update(updateRow)
    .eq("id", input.id)
    .select("*")
    .maybeSingle<AlertEventRow>();
  if (error) throw new Error(error.message);
  return data ? toSafeEvent(data) : null;
}
