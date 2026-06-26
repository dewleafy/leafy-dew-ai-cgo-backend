import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getListingReadiness,
  getListingReadinessDetail
} from "./listing-readiness.controller";

export const listingReadinessRoutes = Router();

listingReadinessRoutes.get("/", asyncHandler(getListingReadiness));
listingReadinessRoutes.get("/:productPassportId", asyncHandler(getListingReadinessDetail));
