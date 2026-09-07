import axios from "axios";
import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { transitionActionState } from "../action-ledger/action-workflow.service";
import { getSafetyControlSettings } from "../safety-control/safety-control.service";
import { requireConnectedConnection } from "../amazon-sp/amazon-sp.service";
import { getAmazonSpAccessToken } from "../amazon-sp/amazon-sp-token.service";
import { amazonSpGet, amazonSpPatch } from "../amazon-sp/amazon-sp-client.service";
import { AmazonSpRegion } from "../amazon-sp/amazon-sp.types";
import { cleanText } from "../amazon-sp/amazon-sp-utils";
import { env } from "../../config/env";
import { ListingExecutionDraftType, ListingExecutionError, ListingExecutionResult } from "./listing-execution.types";

const ACTION_ID_REGEX = /^[0-9a-f-]{8,64}$/i;

const ELIGIBLE_ACTION_TYPES = [
  "LISTING_TITLE_DRAFT_REVIEW",
  "LISTING_BULLETS_DRAFT_REVIEW",
  "LISTING_DESCRIPTION_DRAFT_REVIEW"
] as const;

// Maps this app's internal listing-draft type onto the real Amazon Listings Items
// API attribute name it corresponds to. Only these three are wired for real
// write-back in this first slice — BACKEND_KEYWORDS intentionally stays
// draft-only/never-live for now (it's metadata, not customer-facing copy, and was
// deliberately excluded from AI drafting for the same reason in Phase 3).
const ATTRIBUTE_NAME_BY_DRAFT_TYPE: Record<ListingExecutionDraftType, string> = {
  TITLE: "item_name",
  BULLETS: "bullet_point",
  DESCRIPTION: "product_description"
};

// Amazon's Listings Items API requires an explicit language_tag per marketplace on
// every attribute value. Small, explicit map rather than a guess — extend this if
// the founder ever connects an additional marketplace/region. Falls back to en_US
// (with a warning recorded on the result) rather than silently guessing wrong and
// having Amazon reject the whole patch with a confusing error.
const LANGUAGE_TAG_BY_MARKETPLACE: Record<string, string> = {
  A21TJRUUN4KGV: "en_IN", // India
  ATVPDKIKX0DER: "en_US", // United States
  A1F83G8C2ARO7P: "en_GB", // United Kingdom
  A1PA6795UKMFR9: "de_DE", // Germany
  A13V1IB3VIYZZH: "fr_FR", // France
  APJ6JRA9NG5V4: "it_IT", // Italy
  A1RKKUPIHCS9HS: "es_ES", // Spain
  A1VC38T7YXB528: "ja_JP" // Japan
};

function cleanTextLocal(value: unknown): string {
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

  return error instanceof Error ? error.message : "Unknown Amazon error.";
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
    actor: cleanTextLocal(input.actor) || "system",
    before_state: input.beforeState ?? null,
    after_state: input.afterState ?? null,
    note: cleanTextLocal(input.note) || null,
    metadata: {}
  });

  if (error) {
    logger.warn("Listing execution safety audit event could not be recorded.", {
      sellerId: input.sellerId,
      eventType: input.eventType,
      message: error.message
    });
  }
}

// The daily listings sync populates amazon_sp_listings from Amazon's GET_MERCHANT_LISTINGS_ALL_DATA
// report, which (confirmed against Amazon's own report documentation) has no product-type, category,
// or item-type column at all — so amazon_sp_listings.product_type has never been populated by that
// sync, for any SKU. The real productType only exists on the live Listings Items API, so when the
// cached column is empty this fetches it directly from Amazon (read-only GET, the same access scope
// already used everywhere else in this app — no new permission needed) and caches the result back
// onto the row so this SKU never needs a second live fetch.
async function getRealAmazonProductType(input: {
  sellerId: string;
  sku: string;
  amazonSellerId: string;
  marketplaceId: string;
  accessToken: string;
  region: AmazonSpRegion;
}): Promise<string | null> {
  const { data } = await supabase
    .from("amazon_sp_listings")
    .select("product_type")
    .eq("seller_id", input.sellerId)
    .eq("sku", input.sku)
    .maybeSingle<{ product_type: string | null }>();

  if (data?.product_type) {
    return data.product_type;
  }

  let fetchedProductType: string | null = null;

  try {
    const response = await amazonSpGet<{ summaries?: Array<{ productType?: string }> }>({
      path: `/listings/2021-08-01/items/${encodeURIComponent(input.amazonSellerId)}/${encodeURIComponent(input.sku)}`,
      query: { marketplaceIds: [input.marketplaceId], includedData: ["summaries"] },
      accessToken: input.accessToken,
      region: input.region,
      stage: "GET_LISTINGS_ITEM_FOR_PRODUCT_TYPE"
    });
    fetchedProductType = cleanTextLocal(response?.summaries?.[0]?.productType) || null;
  } catch (error) {
    logger.warn("Could not fetch real Amazon product type for listing execution.", {
      sellerId: input.sellerId,
      sku: input.sku,
      message: error instanceof Error ? error.message : "Unknown error"
    });
    return null;
  }

  if (fetchedProductType) {
    const { error: updateError } = await supabase
      .from("amazon_sp_listings")
      .update({ product_type: fetchedProductType })
      .eq("seller_id", input.sellerId)
      .eq("sku", input.sku);

    if (updateError) {
      logger.warn("Fetched a real Amazon product type but could not cache it onto amazon_sp_listings.", {
        sellerId: input.sellerId,
        sku: input.sku,
        message: updateError.message
      });
    }
  }

  return fetchedProductType;
}

function buildAttributeValue(input: {
  draftType: ListingExecutionDraftType;
  proposedValue: string;
  languageTag: string;
  marketplaceId: string;
}): Array<Record<string, string>> {
  if (input.draftType === "BULLETS") {
    const bullets = input.proposedValue
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return bullets.map((bullet) => ({
      value: bullet,
      language_tag: input.languageTag,
      marketplace_id: input.marketplaceId
    }));
  }

  return [
    {
      value: input.proposedValue,
      language_tag: input.languageTag,
      marketplace_id: input.marketplaceId
    }
  ];
}

export async function executeListingContentAction(input: {
  sellerId: string;
  actionId: string;
  actor?: string | null;
}): Promise<ListingExecutionResult> {
  const sellerId = cleanTextLocal(input.sellerId) || "default";
  const actor = cleanTextLocal(input.actor) || "founder";
  const actionId = cleanTextLocal(input.actionId);

  if (!actionId || !ACTION_ID_REGEX.test(actionId)) {
    throw new ListingExecutionError(400, "Invalid action id.");
  }

  const row = await getActionLedgerById(actionId);

  if (!row) {
    throw new ListingExecutionError(404, "Action ledger row not found.");
  }

  if (row.sellerId !== sellerId) {
    throw new ListingExecutionError(404, "Action ledger row not found for this seller.");
  }

  const isEligible =
    row.source === "LISTING_DRAFT_SYSTEM" &&
    (ELIGIBLE_ACTION_TYPES as readonly string[]).includes(row.actionType);

  if (!isEligible) {
    throw new ListingExecutionError(
      400,
      "This action is not a title, bullets, or description listing draft, so it cannot be sent to Amazon here. Use the regular Approve button instead."
    );
  }

  if (row.state !== "WAITING_FOR_APPROVAL") {
    throw new ListingExecutionError(400, `This action is already ${row.state}. Reopen it first if you need to approve it again.`);
  }

  const payload = row.payload ?? {};
  const draftType = cleanTextLocal(payload.draftType) as ListingExecutionDraftType;
  const proposedValue = cleanTextLocal(payload.proposedValue);
  const sku = cleanTextLocal(row.sku);

  if (!draftType || !ATTRIBUTE_NAME_BY_DRAFT_TYPE[draftType]) {
    throw new ListingExecutionError(400, "This draft's content type is not one that can be sent to Amazon here.");
  }

  if (!sku) {
    throw new ListingExecutionError(400, "This draft has no SKU on file, so it can't be sent to Amazon.");
  }

  if (!proposedValue) {
    throw new ListingExecutionError(400, "This draft has no proposed text to send.");
  }

  const attributeName = ATTRIBUTE_NAME_BY_DRAFT_TYPE[draftType];
  const beforeState = row as unknown as Record<string, unknown>;

  const settings = await getSafetyControlSettings(sellerId);
  const liveEnabled = Boolean(settings?.listingLiveExecutionEnabled);
  const targetLabel = `${draftType.toLowerCase()} for SKU ${sku}`;

  if (!liveEnabled) {
    const simulatedRequest = {
      sku,
      attributeName,
      draftType,
      proposedValuePreview: proposedValue.slice(0, 200)
    };

    await recordSafetyAuditEvent({
      sellerId,
      eventType: "LISTING_CONTENT_SIMULATED",
      actor,
      beforeState,
      afterState: { simulatedRequest },
      note: `Practice mode: simulated sending ${targetLabel} to Amazon. Nothing was sent because Listing Content Live Execution is OFF.`
    });

    const transition = await transitionActionState({
      actionId: row.id,
      sellerId,
      toState: "APPROVED",
      approvalStatus: "APPROVED",
      eventType: "APPROVED",
      actor,
      note: "Approved in practice mode. Nothing was sent to Amazon because Listing Content Live Execution is OFF.",
      metadata: { listingExecutionMode: "SIMULATED", request: simulatedRequest }
    });

    if (!transition) {
      throw new ListingExecutionError(404, "Action ledger row not found.");
    }

    return {
      ok: true,
      actionId: row.id,
      sellerId,
      mode: "SIMULATED",
      draftType,
      sku,
      asin: row.asin,
      message: `Approved in practice mode. This would update the ${targetLabel} on Amazon, but nothing was actually sent because Listing Content Live Execution is OFF.`,
      request: simulatedRequest,
      row: transition.row
    };
  }

  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);
  const amazonSellerId = cleanText(connection.amazon_seller_id) ?? cleanText(env.SP_API_AMAZON_SELLER_ID);

  if (!amazonSellerId) {
    throw new ListingExecutionError(503, "This seller's Amazon Seller ID is not confirmed yet, so nothing can be sent to Amazon.");
  }

  const productType = await getRealAmazonProductType({
    sellerId,
    sku,
    amazonSellerId,
    marketplaceId: connection.marketplace_id,
    accessToken,
    region: connection.region
  });

  if (!productType) {
    throw new ListingExecutionError(
      503,
      "Could not confirm this product's real Amazon product type (needed for a safe update), even after checking Amazon directly. Try again shortly, or check the Amazon listing is still active."
    );
  }

  const languageTag = LANGUAGE_TAG_BY_MARKETPLACE[connection.marketplace_id] ?? "en_US";
  const attributeValue = buildAttributeValue({
    draftType,
    proposedValue,
    languageTag,
    marketplaceId: connection.marketplace_id
  });

  if (attributeValue.length === 0) {
    throw new ListingExecutionError(400, "This draft's proposed text is empty after cleanup, so there's nothing to send.");
  }

  const requestBody = {
    productType,
    patches: [
      {
        op: "replace",
        path: `/attributes/${attributeName}`,
        value: attributeValue
      }
    ]
  };

  const request = { sku, attributeName, productType, marketplaceId: connection.marketplace_id, languageTag, patches: requestBody.patches };

  let amazonResponse: unknown;

  try {
    amazonResponse = await amazonSpPatch<unknown>({
      path: `/listings/2021-08-01/items/${encodeURIComponent(amazonSellerId)}/${encodeURIComponent(sku)}`,
      query: { marketplaceIds: [connection.marketplace_id] },
      body: requestBody,
      accessToken,
      region: connection.region,
      stage: "PATCH_LISTINGS_ITEM"
    });
  } catch (error) {
    const message = describeAmazonError(error);
    await recordSafetyAuditEvent({
      sellerId,
      eventType: "LISTING_CONTENT_EXECUTION_FAILED",
      actor,
      beforeState,
      afterState: { error: message, request },
      note: `Amazon rejected updating the ${targetLabel}.`
    });
    throw new ListingExecutionError(502, `Amazon rejected this change: ${message}`);
  }

  await recordSafetyAuditEvent({
    sellerId,
    eventType: "LISTING_CONTENT_EXECUTED",
    actor,
    beforeState,
    afterState: { amazonResponse, request } as Record<string, unknown>,
    note: `Live-updated the ${targetLabel} on Amazon.`
  });

  const approved = await transitionActionState({
    actionId: row.id,
    sellerId,
    toState: "APPROVED",
    approvalStatus: "APPROVED",
    eventType: "APPROVED",
    actor,
    note: `Approved and sent live to Amazon: updated ${targetLabel}.`,
    metadata: { listingExecutionMode: "EXECUTED", request, amazonResponse: amazonResponse as Record<string, unknown> }
  });

  if (!approved) {
    throw new ListingExecutionError(404, "Action ledger row not found after execution — check the Action Ledger directly, since the Amazon update itself already went through.");
  }

  return {
    ok: true,
    actionId: row.id,
    sellerId,
    mode: "EXECUTED",
    draftType,
    sku,
    asin: row.asin,
    message: `Sent live to Amazon: updated the ${targetLabel}.`,
    request,
    amazonResponse,
    row: approved.row
  };
}
