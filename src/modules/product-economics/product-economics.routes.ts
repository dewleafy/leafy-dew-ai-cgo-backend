import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getProductEconomics,
  getProductEconomicsCostCompletionQueue,
  getProductEconomicsCostReductionOpportunities,
  getProductEconomicsMeasuredReturnRates,
  getProductEconomicsProfitGuardrail,
  getProductEconomicsReturnRatePreview,
  postProductEconomics
} from "./product-economics.controller";

export const productEconomicsRouter = Router();

productEconomicsRouter.post("/", asyncHandler(postProductEconomics));
productEconomicsRouter.get("/cost-completion-queue", asyncHandler(getProductEconomicsCostCompletionQueue));
productEconomicsRouter.get("/cost-reduction-opportunities", asyncHandler(getProductEconomicsCostReductionOpportunities));
productEconomicsRouter.get("/measured-return-rates", asyncHandler(getProductEconomicsMeasuredReturnRates));
productEconomicsRouter.get("/return-rate-preview", asyncHandler(getProductEconomicsReturnRatePreview));
productEconomicsRouter.get("/", asyncHandler(getProductEconomics));
productEconomicsRouter.get("/:id/profit-guardrail", asyncHandler(getProductEconomicsProfitGuardrail));
