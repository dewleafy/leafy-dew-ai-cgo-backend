import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getTodayCommandSummaryRoute } from "./today-command.controller";

export const todayCommandRouter = Router();

todayCommandRouter.get("/summary", asyncHandler(getTodayCommandSummaryRoute));
