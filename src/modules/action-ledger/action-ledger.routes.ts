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
  rejectActionLedgerRow,
  syncRecommendationsToActionLedgerRoute
} from "./action-ledger.controller";

export const actionLedgerRoutes = Router();

actionLedgerRoutes.get(["", "/"], asyncHandler(getActionLedgerRows));
actionLedgerRoutes.get("/summary", asyncHandler(getActionLedgerSummaryRoute));
actionLedgerRoutes.post(["", "/"], asyncHandler(postActionLedgerRow));
actionLedgerRoutes.post("/sync-recommendations", asyncHandler(syncRecommendationsToActionLedgerRoute));
actionLedgerRoutes.post("/:id/approve", asyncHandler(approveActionLedgerRow));
actionLedgerRoutes.post("/:id/reject", asyncHandler(rejectActionLedgerRow));
actionLedgerRoutes.post("/:id/monitor", asyncHandler(monitorActionLedgerRow));
actionLedgerRoutes.post("/:id/complete", asyncHandler(completeActionLedgerRow));
actionLedgerRoutes.get("/:id", asyncHandler(getActionLedgerRow));
