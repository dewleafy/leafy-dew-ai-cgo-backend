import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteProductPassport,
  getProductPassport,
  getProductPassportReadiness,
  getProductPassportReadinessSummaryController,
  getProductPassports,
  postProductPassport,
  postProductPassportBulkComplianceNotesRoute,
  putProductPassport
} from "./product-passports.controller";
import {
  getProductPassportCostCompletion,
  getProductPassportCostCompletionSummaryController,
  postProductPassportCostCompletionBulkUpdate,
  postProductPassportCostCompletionResolveActions
} from "./product-passports-cost-completion.controller";

export const productPassportRoutes = Router();

productPassportRoutes.get("/", asyncHandler(getProductPassports));
productPassportRoutes.get("/list", asyncHandler(getProductPassports));
productPassportRoutes.get("/readiness/summary", asyncHandler(getProductPassportReadinessSummaryController));
productPassportRoutes.get("/cost-completion", asyncHandler(getProductPassportCostCompletion));
productPassportRoutes.post("/cost-completion/bulk-update", asyncHandler(postProductPassportCostCompletionBulkUpdate));
productPassportRoutes.post("/cost-completion/resolve-actions", asyncHandler(postProductPassportCostCompletionResolveActions));
productPassportRoutes.get("/cost-completion/summary", asyncHandler(getProductPassportCostCompletionSummaryController));
productPassportRoutes.post("/compliance-notes/bulk-apply", asyncHandler(postProductPassportBulkComplianceNotesRoute));
productPassportRoutes.get("/:id/readiness", asyncHandler(getProductPassportReadiness));
productPassportRoutes.get("/:id", asyncHandler(getProductPassport));
productPassportRoutes.post("/", asyncHandler(postProductPassport));
productPassportRoutes.put("/:id", asyncHandler(putProductPassport));
productPassportRoutes.delete("/:id", asyncHandler(deleteProductPassport));
