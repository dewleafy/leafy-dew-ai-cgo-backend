import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { postExecutePassportDraftAction } from "./passport-draft-execution.controller";

export const passportDraftExecutionRoutes = Router();

passportDraftExecutionRoutes.post("/:id/execute", asyncHandler(postExecutePassportDraftAction));
