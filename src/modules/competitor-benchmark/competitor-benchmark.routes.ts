import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  getCompetitorBenchmarkImageBrief,
  getCompetitorBenchmarkRunById,
  getCompetitorBenchmarkRuns,
  postCompetitorBenchmarkCompare,
  postCompetitorBenchmarkConfirmCandidates,
  postCompetitorBenchmarkImageMockup,
  postCompetitorBenchmarkRun
} from "./competitor-benchmark.controller";

export const competitorBenchmarkRouter = Router();

competitorBenchmarkRouter.post("/runs", asyncHandler(postCompetitorBenchmarkRun));
competitorBenchmarkRouter.get("/runs", asyncHandler(getCompetitorBenchmarkRuns));
competitorBenchmarkRouter.get("/runs/:id", asyncHandler(getCompetitorBenchmarkRunById));
competitorBenchmarkRouter.post("/runs/:id/candidates/confirm", asyncHandler(postCompetitorBenchmarkConfirmCandidates));
competitorBenchmarkRouter.post("/runs/:id/compare", asyncHandler(postCompetitorBenchmarkCompare));
competitorBenchmarkRouter.get("/runs/:id/image-brief/:sku", asyncHandler(getCompetitorBenchmarkImageBrief));
competitorBenchmarkRouter.post("/runs/:id/image-mockup", asyncHandler(postCompetitorBenchmarkImageMockup));
