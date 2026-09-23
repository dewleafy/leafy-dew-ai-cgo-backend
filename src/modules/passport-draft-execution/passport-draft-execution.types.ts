import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";

// Passport draft types never go to Amazon — approving one just saves the AI-authored text
// straight into the Product Passport row itself (the same data the Brand Readiness score reads).
export type PassportDraftFieldType =
  | "BRAND_POSITIONING"
  | "CUSTOMER_OBJECTIONS"
  | "PACKAGE_CONTENTS"
  | "COMPLIANCE_NOTES"
  | "USE_CASE"
  | "TARGET_CUSTOMER";

export type PassportDraftExecutionResult = {
  ok: true;
  actionId: string;
  sellerId: string;
  draftType: PassportDraftFieldType;
  sku: string | null;
  asin: string | null;
  message: string;
  savedValue: string | string[];
  row: SafeActionLedgerRow;
};

export class PassportDraftExecutionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PassportDraftExecutionError";
  }
}

// One outcome per requested id in a batch "Approve & Save to Passport" run — never throws for an
// individual failure, so one bad/ineligible id never stops the rest of the batch from saving.
export type PassportDraftBatchItemResult =
  | { actionId: string; ok: true; sku: string | null; asin: string | null; draftType: PassportDraftFieldType; message: string }
  | { actionId: string; ok: false; message: string };

export type PassportDraftBatchExecutionResult = {
  ok: true;
  sellerId: string;
  requestedCount: number;
  savedCount: number;
  // Same number as savedCount, included under the app's shared batch-result field name
  // (updatedCount/skippedCount) so the Approval Center's one generic batch-result reader
  // works for this endpoint too, without needing its own special case.
  updatedCount: number;
  skippedCount: number;
  results: PassportDraftBatchItemResult[];
};
