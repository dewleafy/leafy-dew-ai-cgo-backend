import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getAuthStatusRoute, postAuthLoginRoute } from "./auth.controller";

export const authRouter = Router();

authRouter.get("/status", asyncHandler(getAuthStatusRoute));
authRouter.post("/login", asyncHandler(postAuthLoginRoute));
