import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getLatestQaSmokeRunRoute,
  listQaSmokeRunsRoute,
  runQaSmokeRoute
} from "./qa-smoke.controller";

export const qaSmokeRouter = Router();

qaSmokeRouter.post("/run", asyncHandler(runQaSmokeRoute));
qaSmokeRouter.get("/runs", asyncHandler(listQaSmokeRunsRoute));
qaSmokeRouter.get("/latest", asyncHandler(getLatestQaSmokeRunRoute));
