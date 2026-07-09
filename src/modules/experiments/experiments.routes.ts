import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteExperiment,
  getExperiment,
  getExperiments,
  getExperimentsSummary,
  postCancelExperiment,
  postCompleteExperiment,
  postExperiment,
  postExperimentFromAction,
  postRecordCheckpoint,
  postStartExperiment,
  putExperiment
} from "./experiments.controller";

export const experimentRoutes = Router();

experimentRoutes.get("/summary", asyncHandler(getExperimentsSummary));
experimentRoutes.get(["", "/"], asyncHandler(getExperiments));
experimentRoutes.post("/from-action/:actionId", asyncHandler(postExperimentFromAction));
experimentRoutes.get("/:id", asyncHandler(getExperiment));
experimentRoutes.post(["", "/"], asyncHandler(postExperiment));
experimentRoutes.put("/:id", asyncHandler(putExperiment));
experimentRoutes.post("/:id/start", asyncHandler(postStartExperiment));
experimentRoutes.post("/:id/record-checkpoint", asyncHandler(postRecordCheckpoint));
experimentRoutes.post("/:id/complete", asyncHandler(postCompleteExperiment));
experimentRoutes.post("/:id/cancel", asyncHandler(postCancelExperiment));
experimentRoutes.delete("/:id", asyncHandler(deleteExperiment));
