import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteProductPassport,
  getProductPassport,
  getProductPassportReadiness,
  getProductPassportReadinessSummaryController,
  getProductPassports,
  postProductPassport,
  putProductPassport
} from "./product-passports.controller";

export const productPassportRoutes = Router();

productPassportRoutes.get("/", asyncHandler(getProductPassports));
productPassportRoutes.get("/readiness/summary", asyncHandler(getProductPassportReadinessSummaryController));
productPassportRoutes.get("/:id/readiness", asyncHandler(getProductPassportReadiness));
productPassportRoutes.get("/:id", asyncHandler(getProductPassport));
productPassportRoutes.post("/", asyncHandler(postProductPassport));
productPassportRoutes.put("/:id", asyncHandler(putProductPassport));
productPassportRoutes.delete("/:id", asyncHandler(deleteProductPassport));
