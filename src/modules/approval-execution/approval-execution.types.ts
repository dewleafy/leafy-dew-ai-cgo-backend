import { SafeActionLedgerRow } from "../action-ledger/action-ledger.types";

export type ApprovalExecutionSummary = {
  ok: true;
  sellerId: string;
  readyCount: number;
  approvedCount: number;
  monitoringCount: number;
  liveExecutionEnabled: false;
  aiCallsEnabled: false;
  latestReadyActions: SafeActionLedgerRow[];
  message: string;
};
