import axios from "axios";
import { env } from "../../config/env";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { transitionActionState } from "../action-ledger/action-workflow.service";
import { getSafetyControlSettings } from "../safety-control/safety-control.service";
import { getAmazonAdsAccessToken } from "../amazon-ads/amazon-ads-token.service";
import { getFirstAmazonAdsProfile } from "../amazon-ads/amazon-ads-profile.service";
import { AmazonAdsRegion } from "../amazon-ads/amazon-ads.types";
import { PpcExecutionError, PpcExecutionResult, PpcExecutionTargetType } from "./ppc-execution.types";

const AMAZON_ADS_API_ENDPOINTS: Record<AmazonAdsRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com"
};

const ACTION_ID_REGEX = /^[0-9a-f-]{8,64}$/i;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function describeAmazonError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (data !== undefined && data !== null) {
      try {
        return typeof data === "string" ? data : JSON.stringify(data);
      } catch {
        return error.message;
      }
    }
    return error.message;
  }

  return error instanceof Error ? error.message : "Unknown Amazon Ads error.";
}

async function loadAmazonExecutionContext(sellerId: string): Promise<{
  connectionId: string;
  region: AmazonAdsRegion;
  profileId: string;
}> {
  let query = supabase
    .from("amazon_ads_connections")
    .select("*")
    .eq("status", "connected")
    .order("connected_at", { ascending: false })
    .limit(1);

  if (sellerId !== "default") {
    query = query.eq("seller_id", sellerId);
  }

  const { data: connection, error } = await query.maybeSingle<{ id: string; region: AmazonAdsRegion }>();

  if (error) {
    throw new PpcExecutionError(503, "Could not load your Amazon Ads connection.");
  }

  if (!connection) {
    throw new PpcExecutionError(404, "No connected Amazon Ads account found. Connect Amazon Ads first.");
  }

  const profile = await getFirstAmazonAdsProfile(connection.id);

  if (!profile) {
    throw new PpcExecutionError(404, "No Amazon Ads profile found. Reconnect Amazon Ads to sync profiles.");
  }

  return {
    connectionId: connection.id,
    region: connection.region,
    profileId: profile.profile_id
  };
}

async function callAmazonNegativeKeyword(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  campaignId: string;
  adGroupId: string;
  keywordText: string;
}): Promise<unknown> {
  const body = [
    {
      campaignId: input.campaignId,
      adGroupId: input.adGroupId,
      keywordText: input.keywordText,
      matchType: "NEGATIVE_EXACT",
      state: "enabled"
    }
  ];

  const response = await axios.post(`${AMAZON_ADS_API_ENDPOINTS[input.region]}/sp/negativeKeywords`, body, {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Amazon-Advertising-API-ClientId": env.AMAZON_ADS_CLIENT_ID ?? "",
      "Amazon-Advertising-API-Scope": input.profileId,
      "Content-Type": "application/vnd.spNegativeKeyword.v3+json",
      Accept: "application/vnd.spNegativeKeyword.v3+json"
    }
  });

  return response.data;
}

async function callAmazonNegativeTarget(input: {
  accessToken: string;
  region: AmazonAdsRegion;
  profileId: string;
  campaignId: string;
  adGroupId: string;
  asin: string;
}): Promise<unknown> {
  const body = [
    {
      campaignId: input.campaignId,
      adGroupId: input.adGroupId,
      state: "enabled",
      expression: [{ type: "ASIN_SAME_AS", value: input.asin }]
    }
  ];

  const response = await axios.post(`${AMAZON_ADS_API_ENDPOINTS[input.region]}/sp/negativeTargets`, body, {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Amazon-Advertising-API-ClientId": env.AMAZON_ADS_CLIENT_ID ?? "",
      "Amazon-Advertising-API-Scope": input.profileId,
      "Content-Type": "application/vnd.spNegativeTargetingClause.v3+json",
      Accept: "application/vnd.spNegativeTargetingClause.v3+json"
    }
  });

  return response.data;
}

async function recordSafetyAuditEvent(input: {
  sellerId: string;
  eventType: string;
  actor?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  note?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("safety_audit_events").insert({
    seller_id: input.sellerId,
    event_type: input.eventType,
    actor: cleanText(input.actor) || "system",
    before_state: input.beforeState ?? null,
    after_state: input.afterState ?? null,
    note: cleanText(input.note) || null,
    metadata: {}
  });

  if (error) {
    logger.warn("PPC execution safety audit event could not be recorded.", {
      sellerId: input.sellerId,
      eventType: input.eventType,
      message: error.message
    });
  }
}

export async function executeNegativeAction(input: {
  sellerId: string;
  actionId: string;
  actor?: string | null;
}): Promise<PpcExecutionResult> {
  const sellerId = cleanText(input.sellerId) || "default";
  const actor = cleanText(input.actor) || "founder";
  const actionId = cleanText(input.actionId);

  if (!actionId || !ACTION_ID_REGEX.test(actionId)) {
    throw new PpcExecutionError(400, "Invalid action id.");
  }

  const row = await getActionLedgerById(actionId);

  if (!row) {
    throw new PpcExecutionError(404, "Action ledger row not found.");
  }

  if (row.sellerId !== sellerId) {
    throw new PpcExecutionError(404, "Action ledger row not found for this seller.");
  }

  const recommendedAction = cleanText(row.recommendedAction).toUpperCase();
  const isEligible =
    row.source === "PPC_RECOMMENDATIONS" &&
    row.actionType === "PAUSE_OR_REDUCE_SPEND_AFTER_APPROVAL" &&
    recommendedAction === "ADD_NEGATIVE_AFTER_APPROVAL";

  if (!isEligible) {
    throw new PpcExecutionError(
      400,
      "This action is not a negative-keyword or negative-product-target recommendation, so it cannot be executed here. Use the regular Approve button instead."
    );
  }

  if (row.state !== "WAITING_FOR_APPROVAL") {
    throw new PpcExecutionError(400, `This action is already ${row.state}. Reopen it first if you need to approve it again.`);
  }

  const isProductTarget = row.entityType === "ASIN";
  const payload = row.payload ?? {};
  const campaignId = cleanText(payload.campaignId);
  const adGroupId = cleanText(payload.adGroupId);
  const targetValue = cleanText(isProductTarget ? row.asin : row.entityId);

  if (!campaignId || !adGroupId || !targetValue) {
    throw new PpcExecutionError(
      400,
      "This recommendation is missing the campaign, ad group, or target details needed to execute it on Amazon."
    );
  }

  const targetType: PpcExecutionTargetType = isProductTarget ? "NEGATIVE_PRODUCT_TARGET" : "NEGATIVE_KEYWORD";
  const targetLabel = isProductTarget ? `negative product target (${targetValue})` : `negative keyword "${targetValue}"`;
  const beforeState = row as unknown as Record<string, unknown>;

  const request: Record<string, unknown> = isProductTarget
    ? { campaignId, adGroupId, state: "enabled", expression: [{ type: "ASIN_SAME_AS", value: targetValue }] }
    : { campaignId, adGroupId, keywordText: targetValue, matchType: "NEGATIVE_EXACT", state: "enabled" };

  const settings = await getSafetyControlSettings(sellerId);
  const liveEnabled = Boolean(settings?.ppcLiveExecutionEnabled);

  if (!liveEnabled) {
    await recordSafetyAuditEvent({
      sellerId,
      eventType: "PPC_NEGATIVE_SIMULATED",
      actor,
      beforeState,
      afterState: { simulatedRequest: request },
      note: `Practice mode: simulated ${targetLabel}. Nothing was sent to Amazon because PPC Live Execution is OFF.`
    });

    const transition = await transitionActionState({
      actionId: row.id,
      sellerId,
      toState: "APPROVED",
      approvalStatus: "APPROVED",
      eventType: "APPROVED",
      actor,
      note: "Approved in practice mode. Nothing was sent to Amazon because PPC Live Execution is OFF.",
      metadata: { ppcExecutionMode: "SIMULATED", request }
    });

    if (!transition) {
      throw new PpcExecutionError(404, "Action ledger row not found.");
    }

    return {
      ok: true,
      actionId: row.id,
      sellerId,
      mode: "SIMULATED",
      targetType,
      targetValue,
      campaignId,
      adGroupId,
      message: `Approved in practice mode. This would add a ${targetLabel} on Amazon, but nothing was actually sent because PPC Live Execution is OFF.`,
      request,
      row: transition.row
    };
  }

  const context = await loadAmazonExecutionContext(sellerId);
  const accessToken = await getAmazonAdsAccessToken(context.connectionId);

  let amazonResponse: unknown;

  try {
    amazonResponse = isProductTarget
      ? await callAmazonNegativeTarget({
          accessToken,
          region: context.region,
          profileId: context.profileId,
          campaignId,
          adGroupId,
          asin: targetValue
        })
      : await callAmazonNegativeKeyword({
          accessToken,
          region: context.region,
          profileId: context.profileId,
          campaignId,
          adGroupId,
          keywordText: targetValue
        });
  } catch (error) {
    const message = describeAmazonError(error);
    await recordSafetyAuditEvent({
      sellerId,
      eventType: "PPC_NEGATIVE_EXECUTION_FAILED",
      actor,
      beforeState,
      afterState: { error: message, request },
      note: `Amazon rejected the ${targetLabel}.`
    });
    throw new PpcExecutionError(502, `Amazon rejected this change: ${message}`);
  }

  await recordSafetyAuditEvent({
    sellerId,
    eventType: "PPC_NEGATIVE_EXECUTED",
    actor,
    beforeState,
    afterState: { amazonResponse, request } as Record<string, unknown>,
    note: `Live-executed ${targetLabel} on Amazon Ads.`
  });

  const approved = await transitionActionState({
    actionId: row.id,
    sellerId,
    toState: "APPROVED",
    approvalStatus: "APPROVED",
    eventType: "APPROVED",
    actor,
    note: "Approved and sent to Amazon Ads.",
    metadata: { ppcExecutionMode: "EXECUTED", request, amazonResponse: amazonResponse as Record<string, unknown> }
  });

  if (!approved) {
    throw new PpcExecutionError(
      404,
      "Action ledger row not found after execution. Check Amazon Ads directly — the change may have already gone through."
    );
  }

  const completed = await transitionActionState({
    actionId: row.id,
    sellerId,
    toState: "COMPLETED",
    approvalStatus: "COMPLETED",
    eventType: "COMPLETED",
    actor,
    note: "Confirmed live on Amazon Ads.",
    metadata: { ppcExecutionMode: "EXECUTED", request, amazonResponse: amazonResponse as Record<string, unknown> }
  });

  return {
    ok: true,
    actionId: row.id,
    sellerId,
    mode: "EXECUTED",
    targetType,
    targetValue,
    campaignId,
    adGroupId,
    message: `Done — this ${targetLabel} is now live on Amazon Ads.`,
    request,
    amazonResponse,
    row: (completed ?? approved).row
  };
}
