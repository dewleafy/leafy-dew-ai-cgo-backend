import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getProductEconomics,
  getProductEconomicsProfitGuardrail,
  postProductEconomics
} from "./product-economics.controller";

export const productEconomicsRouter = Router();

productEconomicsRouter.post("/", asyncHandler(postProductEconomics));
productEconomicsRouter.get("/", asyncHandler(getProductEconomics));
productEconomicsRouter.get("/:id/profit-guardrail", asyncHandler(getProductEconomicsProfitGuardrail));
