import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  estimateAiUsageRoute,
  getAiCostSummaryRoute,
  getAiGatewayStatusRoute,
  listAiCostLedgerRoute,
  recordBlockedAiAttemptRoute
} from "./ai-gateway.controller";

export const aiGatewayRouter = Router();

aiGatewayRouter.get("/status", asyncHandler(getAiGatewayStatusRoute));
aiGatewayRouter.get("/cost-summary", asyncHandler(getAiCostSummaryRoute));
aiGatewayRouter.get("/ledger", asyncHandler(listAiCostLedgerRoute));
aiGatewayRouter.post("/estimate", asyncHandler(estimateAiUsageRoute));
aiGatewayRouter.post("/record-blocked", asyncHandler(recordBlockedAiAttemptRoute));
