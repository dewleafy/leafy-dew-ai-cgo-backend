import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { postExecutePpcNegativeAction } from "./ppc-execution.controller";

export const ppcExecutionRoutes = Router();

ppcExecutionRoutes.post("/:id/execute", asyncHandler(postExecutePpcNegativeAction));
