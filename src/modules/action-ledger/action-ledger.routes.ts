import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  approveActionLedgerRow,
  completeActionLedgerRow,
  getActionLedgerRow,
  getActionLedgerRows,
  getActionLedgerSummaryRoute,
  monitorActionLedgerRow,
  postActionLedgerRow,
  rejectActionLedgerRow
} from "./action-ledger.controller";

export const actionLedgerRoutes = Router();

actionLedgerRoutes.get(["", "/"], asyncHandler(getActionLedgerRows));
actionLedgerRoutes.get("/summary", asyncHandler(getActionLedgerSummaryRoute));
actionLedgerRoutes.post(["", "/"], asyncHandler(postActionLedgerRow));
actionLedgerRoutes.get("/:id", asyncHandler(getActionLedgerRow));
actionLedgerRoutes.post("/:id/approve", asyncHandler(approveActionLedgerRow));
actionLedgerRoutes.post("/:id/reject", asyncHandler(rejectActionLedgerRow));
actionLedgerRoutes.post("/:id/monitor", asyncHandler(monitorActionLedgerRow));
actionLedgerRoutes.post("/:id/complete", asyncHandler(completeActionLedgerRow));
