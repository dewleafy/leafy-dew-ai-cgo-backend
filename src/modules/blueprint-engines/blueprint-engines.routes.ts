import { Router } from "express";
import { asyncHandler } from "../../utils/async-handler";
import { getBlueprintCoverage } from "./blueprint-engines.service";

export const blueprintEnginesRouter = Router();

blueprintEnginesRouter.get(
  "/coverage",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await getBlueprintCoverage() });
  })
);
