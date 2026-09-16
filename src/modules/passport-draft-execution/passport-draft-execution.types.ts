import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";

// Passport draft types never go to Amazon — approving one just saves the AI-authored text
// straight into the Product Passport row itself (the same data the Brand Readiness score reads).
export type PassportDraftFieldType = "BRAND_POSITIONING" | "CUSTOMER_OBJECTIONS";

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
