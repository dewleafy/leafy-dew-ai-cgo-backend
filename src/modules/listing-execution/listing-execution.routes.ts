import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { postExecuteListingContentAction } from "./listing-execution.controller";

export const listingExecutionRoutes = Router();

listingExecutionRoutes.post("/:id/execute", asyncHandler(postExecuteListingContentAction));
