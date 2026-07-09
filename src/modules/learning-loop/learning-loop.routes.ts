import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getLearningLoopEngineRoute,
  getLearningLoopEventsRoute,
  getLearningLoopSummaryRoute,
  postManualLearningNoteRoute,
  rebuildLearningLoopRoute
} from "./learning-loop.controller";

export const learningLoopRouter = Router();

learningLoopRouter.get("/summary", asyncHandler(getLearningLoopSummaryRoute));
learningLoopRouter.get("/events", asyncHandler(getLearningLoopEventsRoute));
learningLoopRouter.get("/engine/:engineKey", asyncHandler(getLearningLoopEngineRoute));
learningLoopRouter.post("/rebuild", asyncHandler(rebuildLearningLoopRoute));
learningLoopRouter.post("/manual-note", asyncHandler(postManualLearningNoteRoute));
