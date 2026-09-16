import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";
import { getActionLedgerById } from "../action-ledger/action-ledger.service";
import { transitionActionState } from "../action-ledger/action-workflow.service";
import { safeRecordActivityLog } from "../activity-logs/activity-logs.service";
import {
  PassportDraftBatchExecutionResult,
  PassportDraftBatchItemResult,
  PassportDraftExecutionError,
  PassportDraftExecutionResult,
  PassportDraftFieldType
} from "./passport-draft-execution.types";

const ACTION_ID_REGEX = /^[0-9a-f-]{8,64}$/i;

const ELIGIBLE_ACTION_TYPES = ["PASSPORT_BRAND_POSITIONING_DRAFT_REVIEW", "PASSPORT_CUSTOMER_OBJECTIONS_DRAFT_REVIEW"] as const;

// Maps this app's internal passport-draft type onto the real product_passports column it fills in.
const PASSPORT_COLUMN_BY_DRAFT_TYPE: Record<PassportDraftFieldType, string> = {
  BRAND_POSITIONING: "brand_positioning",
  CUSTOMER_OBJECTIONS: "customer_objections"
};

function cleanTextLocal(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

// The AI drafts customer objections as one "Objection: ... — Address by: ..." line per
// objection (see listing-drafts.service.ts's CUSTOMER_OBJECTIONS prompt). Split back into a
// plain array of strings for the jsonb customer_objections column.
function parseCustomerObjections(proposedValue: string): string[] {
  return proposedValue
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function findPassportRowId(input: { sellerId: string; sku: string | null; asin: string | null }): Promise<string | null> {
  if (input.sku) {
    const { data } = await supabase
      .from("product_passports")
      .select("id")
      .eq("seller_id", input.sellerId)
      .eq("sku", input.sku)
      .maybeSingle<{ id: string }>();
    if (data?.id) return data.id;
  }

  if (input.asin) {
    const { data } = await supabase
      .from("product_passports")
      .select("id")
      .eq("seller_id", input.sellerId)
      .eq("asin", input.asin)
      .maybeSingle<{ id: string }>();
    if (data?.id) return data.id;
  }

  return null;
}

export async function executePassportDraftAction(input: {
  sellerId: string;
  actionId: string;
  actor?: string | null;
}): Promise<PassportDraftExecutionResult> {
  const sellerId = cleanTextLocal(input.sellerId) || "default";
  const actor = cleanTextLocal(input.actor) || "founder";
  const actionId = cleanTextLocal(input.actionId);

  if (!actionId || !ACTION_ID_REGEX.test(actionId)) {
    throw new PassportDraftExecutionError(400, "Invalid action id.");
  }

  const row = await getActionLedgerById(actionId);

  if (!row) {
    throw new PassportDraftExecutionError(404, "Action ledger row not found.");
  }

  if (row.sellerId !== sellerId) {
    throw new PassportDraftExecutionError(404, "Action ledger row not found for this seller.");
  }

  const isEligible = row.source === "LISTING_DRAFT_SYSTEM" && (ELIGIBLE_ACTION_TYPES as readonly string[]).includes(row.actionType);

  if (!isEligible) {
    throw new PassportDraftExecutionError(
      400,
      "This action is not a brand positioning or customer objections draft, so it cannot be saved to the Product Passport here. Use the regular Approve button instead."
    );
  }

  if (row.state !== "WAITING_FOR_APPROVAL") {
    throw new PassportDraftExecutionError(400, `This action is already ${row.state}. Reopen it first if you need to approve it again.`);
  }

  const payload = row.payload ?? {};
  const draftType = cleanTextLocal(payload.draftType) as PassportDraftFieldType;
  const proposedValue = cleanTextLocal(payload.proposedValue);
  const sku = cleanTextLocal(row.sku) || null;
  const asin = cleanTextLocal(row.asin) || null;

  if (!draftType || !PASSPORT_COLUMN_BY_DRAFT_TYPE[draftType]) {
    throw new PassportDraftExecutionError(400, "This draft's content type cannot be saved to the Product Passport here.");
  }

  if (!proposedValue) {
    throw new PassportDraftExecutionError(400, "This draft has no proposed text to save.");
  }

  const passportId = await findPassportRowId({ sellerId, sku, asin });

  if (!passportId) {
    throw new PassportDraftExecutionError(404, "Could not find this product's Product Passport row to save the draft into.");
  }

  const column = PASSPORT_COLUMN_BY_DRAFT_TYPE[draftType];
  const savedValue: string | string[] = draftType === "CUSTOMER_OBJECTIONS" ? parseCustomerObjections(proposedValue) : proposedValue;

  const { error: updateError } = await supabase
    .from("product_passports")
    .update({ [column]: savedValue, updated_at: new Date().toISOString() })
    .eq("id", passportId);

  if (updateError) {
    logger.warn("Could not save passport draft into Product Passport.", {
      sellerId,
      actionId,
      draftType,
      message: updateError.message
    });
    throw new PassportDraftExecutionError(502, `Could not save this to the Product Passport: ${updateError.message}`);
  }

  const targetLabel = `${draftType.toLowerCase().replace(/_/g, " ")}${sku ? ` for SKU ${sku}` : ""}`;

  const transition = await transitionActionState({
    actionId: row.id,
    sellerId,
    toState: "APPROVED",
    approvalStatus: "APPROVED",
    eventType: "APPROVED",
    actor,
    note: `Approved and saved ${targetLabel} to the Product Passport.`,
    metadata: { passportDraftExecution: true, column, savedValue }
  });

  if (!transition) {
    throw new PassportDraftExecutionError(
      404,
      "Action ledger row not found after saving — check the Action Ledger directly, since the Product Passport was already updated."
    );
  }

  await safeRecordActivityLog({
    sellerId,
    eventType: "PASSPORT_DRAFT_SAVED",
    eventCategory: "LISTING_DRAFTS",
    severity: "INFO",
    actor,
    title: "Passport draft saved",
    message: `Saved ${targetLabel} to the Product Passport after founder approval.`,
    entityType: asin ? "ASIN" : sku ? "SKU" : "ACCOUNT",
    entityId: asin ?? sku ?? row.id,
    sku,
    asin,
    actionId: row.id,
    sourceModule: "passport-draft-execution",
    metadata: { draftType, column }
  });

  return {
    ok: true,
    actionId: row.id,
    sellerId,
    draftType,
    sku,
    asin,
    message: `Saved to the Product Passport: ${targetLabel}.`,
    savedValue,
    row: transition.row
  };
}

// Runs executePassportDraftAction() for each id in turn (not in parallel — each one does a real
// Supabase write plus a workflow-state transition, and running them one at a time keeps this
// simple and safe rather than racing writes against the same table). One id's failure (already
// approved, wrong type, missing passport row, etc.) is recorded and skipped — it never stops the
// rest of the batch, since a founder selecting 50 cards should get 49 real saves even if 1 is stale.
export async function batchExecutePassportDraftActions(input: {
  sellerId: string;
  actionIds: string[];
  actor?: string | null;
}): Promise<PassportDraftBatchExecutionResult> {
  const sellerId = cleanTextLocal(input.sellerId) || "default";
  const actor = cleanTextLocal(input.actor) || "founder";
  const results: PassportDraftBatchItemResult[] = [];

  for (const rawActionId of input.actionIds) {
    const actionId = cleanTextLocal(rawActionId);

    try {
      const result = await executePassportDraftAction({ sellerId, actionId, actor });
      results.push({
        actionId: result.actionId,
        ok: true,
        sku: result.sku,
        asin: result.asin,
        draftType: result.draftType,
        message: result.message
      });
    } catch (error) {
      const message =
        error instanceof PassportDraftExecutionError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Could not save this draft to the Product Passport.";
      results.push({ actionId, ok: false, message });
    }
  }

  const savedCount = results.filter((r) => r.ok).length;

  return {
    ok: true,
    sellerId,
    requestedCount: input.actionIds.length,
    savedCount,
    updatedCount: savedCount,
    skippedCount: results.length - savedCount,
    results
  };
}
