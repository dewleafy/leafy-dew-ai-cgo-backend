import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";

export type PpcExecutionMode = "SIMULATED" | "EXECUTED";

export type PpcExecutionTargetType = "NEGATIVE_KEYWORD" | "NEGATIVE_PRODUCT_TARGET";

export type PpcExecutionResult = {
  ok: true;
  actionId: string;
  sellerId: string;
  mode: PpcExecutionMode;
  targetType: PpcExecutionTargetType;
  targetValue: string;
  campaignId: string;
  adGroupId: string;
  message: string;
  request: Record<string, unknown>;
  amazonResponse?: unknown;
  row: SafeActionLedgerRow;
};

export class PpcExecutionError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PpcExecutionError";
  }
}
