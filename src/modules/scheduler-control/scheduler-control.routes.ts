import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getSchedulerControlSummaryRoute,
  listSchedulerJobsRoute,
  runSchedulerJobRoute,
  seedSchedulerJobsRoute,
  updateSchedulerJobRoute
} from "./scheduler-control.controller";

export const schedulerControlRouter = Router();

schedulerControlRouter.get("/summary", asyncHandler(getSchedulerControlSummaryRoute));
schedulerControlRouter.get("/jobs", asyncHandler(listSchedulerJobsRoute));
schedulerControlRouter.post("/seed-jobs", asyncHandler(seedSchedulerJobsRoute));
schedulerControlRouter.post("/run/:jobKey", asyncHandler(runSchedulerJobRoute));
schedulerControlRouter.patch("/jobs/:jobKey", asyncHandler(updateSchedulerJobRoute));
