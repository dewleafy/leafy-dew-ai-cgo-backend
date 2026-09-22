import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getOrderEconomicsSummary } from "./order-economics.controller";

export const orderEconomicsRouter = Router();

orderEconomicsRouter.get("/summary", asyncHandler(getOrderEconomicsSummary));
