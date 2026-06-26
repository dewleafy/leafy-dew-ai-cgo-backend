import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getBrandReadinessController } from "./brand-readiness.controller";

export const brandReadinessRoutes = Router();

brandReadinessRoutes.get(["", "/"], asyncHandler(getBrandReadinessController));
