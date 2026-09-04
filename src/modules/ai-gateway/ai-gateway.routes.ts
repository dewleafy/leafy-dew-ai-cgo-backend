import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  estimateAiUsageRoute,
  generateAiResponseRoute,
  getAiCostSummaryRoute,
  getAiGatewayStatusRoute,
  listAiCostLedgerRoute,
  recordBlockedAiAttemptRoute,
  updateAiGatewaySettingsRoute
} from "./ai-gateway.controller";

export const aiGatewayRouter = Router();

aiGatewayRouter.get("/status", asyncHandler(getAiGatewayStatusRoute));
aiGatewayRouter.get("/cost-summary", asyncHandler(getAiCostSummaryRoute));
aiGatewayRouter.get("/ledger", asyncHandler(listAiCostLedgerRoute));
aiGatewayRouter.post("/estimate", asyncHandler(estimateAiUsageRoute));
aiGatewayRouter.post("/record-blocked", asyncHandler(recordBlockedAiAttemptRoute));
aiGatewayRouter.post("/generate", asyncHandler(generateAiResponseRoute));
aiGatewayRouter.patch("/settings", asyncHandler(updateAiGatewaySettingsRoute));
