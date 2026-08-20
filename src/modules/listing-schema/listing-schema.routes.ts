import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { checkListingSchemaReadinessRoute } from "./listing-schema.controller";

export const listingSchemaRouter = Router();

listingSchemaRouter.get("/check", asyncHandler(checkListingSchemaReadinessRoute));
