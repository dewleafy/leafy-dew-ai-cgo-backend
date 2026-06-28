import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  deleteExperiment,
  getExperiment,
  getExperiments,
  postCancelExperiment,
  postCompleteExperiment,
  postExperiment,
  postStartExperiment,
  putExperiment
} from "./experiments.controller";

export const experimentRoutes = Router();

experimentRoutes.get(["", "/"], asyncHandler(getExperiments));
experimentRoutes.get("/:id", asyncHandler(getExperiment));
experimentRoutes.post(["", "/"], asyncHandler(postExperiment));
experimentRoutes.put("/:id", asyncHandler(putExperiment));
experimentRoutes.post("/:id/start", asyncHandler(postStartExperiment));
experimentRoutes.post("/:id/complete", asyncHandler(postCompleteExperiment));
experimentRoutes.post("/:id/cancel", asyncHandler(postCancelExperiment));
experimentRoutes.delete("/:id", asyncHandler(deleteExperiment));
