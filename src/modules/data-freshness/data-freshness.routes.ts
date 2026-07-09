import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  checkDataFreshnessRoute,
  getDataFreshnessSummaryRoute,
  markDataFreshnessRoute
} from "./data-freshness.controller";

export const dataFreshnessRouter = Router();

dataFreshnessRouter.get("/summary", asyncHandler(getDataFreshnessSummaryRoute));
dataFreshnessRouter.post("/check", asyncHandler(checkDataFreshnessRoute));
dataFreshnessRouter.post("/mark", asyncHandler(markDataFreshnessRoute));
