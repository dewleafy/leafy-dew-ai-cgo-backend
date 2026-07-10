import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import {
  captureRollbackSnapshotRoute,
  executeRollbackSnapshotRoute,
  getRollbackSummaryRoute,
  listRollbackSnapshotsForActionRoute,
  listRollbackSnapshotsRoute,
  previewRollbackSnapshotRoute
} from "./rollback.controller";

export const rollbackRouter = Router();

rollbackRouter.get("/summary", asyncHandler(getRollbackSummaryRoute));
rollbackRouter.get("/snapshots", asyncHandler(listRollbackSnapshotsRoute));
rollbackRouter.get("/action/:actionId", asyncHandler(listRollbackSnapshotsForActionRoute));
rollbackRouter.post("/capture/:actionId", asyncHandler(captureRollbackSnapshotRoute));
rollbackRouter.post("/preview/:snapshotId", asyncHandler(previewRollbackSnapshotRoute));
rollbackRouter.post("/execute/:snapshotId", asyncHandler(executeRollbackSnapshotRoute));
