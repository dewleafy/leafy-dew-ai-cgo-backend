import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  approveActionLedgerRow,
  backfillActionLedgerWorkflowRoute,
  batchCompleteActionLedgerRows,
  batchDeleteActionLedgerRowsRoute,
  batchMonitorActionLedgerRows,
  batchRejectActionLedgerRows,
  completeActionLedgerRow,
  dismissLowPriorityActionLedgerRowsRoute,
  getActionLedgerRollbackPreviewRoute,
  getActionLedgerRow,
  getActionLedgerDailyPrioritiesRoute,
  getActionLedgerRows,
  getActionLedgerSummaryRoute,
  getActionLedgerWorkflowRoute,
  monitorActionLedgerRow,
  postActionLedgerRow,
  reopenActionLedgerRow,
  rejectActionLedgerRow,
  syncRecommendationsToActionLedgerRoute
} from "./action-ledger.controller";

export const actionLedgerRoutes = Router();

actionLedgerRoutes.get(["", "/"], asyncHandler(getActionLedgerRows));
actionLedgerRoutes.get("/summary", asyncHandler(getActionLedgerSummaryRoute));
actionLedgerRoutes.post(["", "/"], asyncHandler(postActionLedgerRow));
actionLedgerRoutes.post("/sync-recommendations", asyncHandler(syncRecommendationsToActionLedgerRoute));
actionLedgerRoutes.get("/daily-priorities", asyncHandler(getActionLedgerDailyPrioritiesRoute));
actionLedgerRoutes.post("/batch/reject", asyncHandler(batchRejectActionLedgerRows));
actionLedgerRoutes.post("/batch/monitor", asyncHandler(batchMonitorActionLedgerRows));
actionLedgerRoutes.post("/batch/complete", asyncHandler(batchCompleteActionLedgerRows));
actionLedgerRoutes.post("/batch/dismiss-low-priority", asyncHandler(dismissLowPriorityActionLedgerRowsRoute));
actionLedgerRoutes.post("/batch/delete", asyncHandler(batchDeleteActionLedgerRowsRoute));
actionLedgerRoutes.post("/workflow/backfill", asyncHandler(backfillActionLedgerWorkflowRoute));
actionLedgerRoutes.get("/:id/workflow", asyncHandler(getActionLedgerWorkflowRoute));
actionLedgerRoutes.get("/:id/rollback-preview", asyncHandler(getActionLedgerRollbackPreviewRoute));
actionLedgerRoutes.get("/:id", asyncHandler(getActionLedgerRow));
actionLedgerRoutes.post("/:id/approve", asyncHandler(approveActionLedgerRow));
actionLedgerRoutes.post("/:id/reject", asyncHandler(rejectActionLedgerRow));
actionLedgerRoutes.post("/:id/monitor", asyncHandler(monitorActionLedgerRow));
actionLedgerRoutes.post("/:id/complete", asyncHandler(completeActionLedgerRow));
actionLedgerRoutes.post("/:id/reopen", asyncHandler(reopenActionLedgerRow));
