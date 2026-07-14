import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getProductMediaDebugController } from "./product-media.controller";

export const productMediaRouter = Router();

productMediaRouter.get("/debug", asyncHandler(getProductMediaDebugController));
