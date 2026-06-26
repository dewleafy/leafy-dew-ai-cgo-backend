import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getDailyCeoReportController } from "./ceo-report.controller";

export const ceoReportRouter = Router();

ceoReportRouter.get("/daily", asyncHandler(getDailyCeoReportController));
