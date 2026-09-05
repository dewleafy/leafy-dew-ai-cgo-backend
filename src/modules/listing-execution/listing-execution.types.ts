import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";

export type ListingExecutionMode = "SIMULATED" | "EXECUTED";

export type ListingExecutionDraftType = "TITLE" | "BULLETS" | "DESCRIPTION";

export type ListingExecutionResult = {
  ok: true;
  actionId: string;
  sellerId: string;
  mode: ListingExecutionMode;
  draftType: ListingExecutionDraftType;
  sku: string;
  asin: string | null;
  message: string;
  request: Record<string, unknown>;
  amazonResponse?: unknown;
  row: SafeActionLedgerRow;
};

export class ListingExecutionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ListingExecutionError";
  }
}
