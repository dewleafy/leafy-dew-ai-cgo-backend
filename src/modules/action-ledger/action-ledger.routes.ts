import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  approveActionLedgerRow,
  batchCompleteActionLedgerRows,
  batchMonitorActionLedgerRows,
  batchRejectActionLedgerRows,
  completeActionLedgerRow,
  dismissLowPriorityActionLedgerRowsRoute,
  getActionLedgerRow,
  getActionLedgerDailyPrioritiesRoute,
  getActionLedgerRows,
  getActionLedgerSummaryRoute,
  monitorActionLedgerRow,
  postActionLedgerRow,
  rejectActionLedgerRow,
  syncRecommendationsToActionLedgerRoute
} from "./action-ledger.controller";

export const actionLedgerRoutes = Router();

actionLedgerRoutes.get(["", "/"], asyncHandler(getActionLedgerRows));
actionLedgerRoutes.get("/summary", asyncHandler(getActionLedgerSummaryRoute));
actionLedgerRoutes.get("/daily-priorities", asyncHandler(getActionLedgerDailyPrioritiesRoute));
actionLedgerRoutes.post(["", "/"], asyncHandler(postActionLedgerRow));
actionLedgerRoutes.post("/sync-recommendations", asyncHandler(syncRecommendationsToActionLedgerRoute));
actionLedgerRoutes.post("/batch/reject", asyncHandler(batchRejectActionLedgerRows));
actionLedgerRoutes.post("/batch/monitor", asyncHandler(batchMonitorActionLedgerRows));
actionLedgerRoutes.post("/batch/complete", asyncHandler(batchCompleteActionLedgerRows));
actionLedgerRoutes.post("/batch/dismiss-low-priority", asyncHandler(dismissLowPriorityActionLedgerRowsRoute));
actionLedgerRoutes.post("/:id/approve", asyncHandler(approveActionLedgerRow));
actionLedgerRoutes.post("/:id/reject", asyncHandler(rejectActionLedgerRow));
actionLedgerRoutes.post("/:id/monitor", asyncHandler(monitorActionLedgerRow));
actionLedgerRoutes.post("/:id/complete", asyncHandler(completeActionLedgerRow));
actionLedgerRoutes.get("/:id", asyncHandler(getActionLedgerRow));
