import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { postBatchExecutePassportDraftActions, postExecutePassportDraftAction } from "./passport-draft-execution.controller";

export const passportDraftExecutionRoutes = Router();

// Registered before the "/:id/execute" route below so the literal "batch" segment is never
// swallowed by the ":id" param.
passportDraftExecutionRoutes.post("/batch/execute", asyncHandler(postBatchExecutePassportDraftActions));
passportDraftExecutionRoutes.post("/:id/execute", asyncHandler(postExecutePassportDraftAction));
