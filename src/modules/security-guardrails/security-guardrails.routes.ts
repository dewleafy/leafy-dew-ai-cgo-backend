import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  checkSecurityGuardrailRoute,
  getSecurityGuardrailsSummaryRoute,
  listSecurityAuditEventsRoute
} from "./security-guardrails.controller";

export const securityGuardrailsRouter = Router();

securityGuardrailsRouter.get("/summary", asyncHandler(getSecurityGuardrailsSummaryRoute));
securityGuardrailsRouter.get("/audit", asyncHandler(listSecurityAuditEventsRoute));
securityGuardrailsRouter.post("/check", asyncHandler(checkSecurityGuardrailRoute));
