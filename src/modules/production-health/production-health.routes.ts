import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getProductionHealthSummaryRoute } from "./production-health.controller";

export const productionHealthRouter = Router();

productionHealthRouter.get("/summary", asyncHandler(getProductionHealthSummaryRoute));
