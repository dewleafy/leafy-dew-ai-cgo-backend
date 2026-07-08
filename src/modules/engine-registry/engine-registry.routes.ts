import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getEngineRegistry,
  getEngineRegistryDetail,
  getEngineRegistrySummaryController,
  postRunPreviewEngineRegistry,
  postSeedEngineRegistry300,
  postToggleEngineRegistry
} from "./engine-registry.controller";

export const engineRegistryRouter = Router();

engineRegistryRouter.get(["", "/"], asyncHandler(getEngineRegistry));
engineRegistryRouter.get("/summary", asyncHandler(getEngineRegistrySummaryController));
engineRegistryRouter.post("/seed-300", asyncHandler(postSeedEngineRegistry300));
engineRegistryRouter.get("/:engineKey", asyncHandler(getEngineRegistryDetail));
engineRegistryRouter.post("/:engineKey/toggle", asyncHandler(postToggleEngineRegistry));
engineRegistryRouter.post("/:engineKey/run-preview", asyncHandler(postRunPreviewEngineRegistry));
