import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getMaintenanceSummaryRoute,
  listMaintenanceRunsRoute,
  runMaintenanceRoute
} from "./maintenance.controller";

export const maintenanceRouter = Router();

maintenanceRouter.post("/run", asyncHandler(runMaintenanceRoute));
maintenanceRouter.get("/runs", asyncHandler(listMaintenanceRunsRoute));
maintenanceRouter.get("/summary", asyncHandler(getMaintenanceSummaryRoute));
