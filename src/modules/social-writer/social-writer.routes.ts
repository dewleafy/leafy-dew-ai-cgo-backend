import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/async-handler";
import { writeNextDrafts } from "./social-writer.service";

export const socialWriterRouter = Router();

const bodySchema = z.object({
  days: z.number().int().min(1).max(30).optional().default(14),
  limit: z.number().int().min(1).max(10).optional().default(5)
});

// Creates DRAFT rows only. Nothing is posted.
socialWriterRouter.post(
  "/write-next",
  asyncHandler(async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, message: "Check days (1 to 30) and limit (1 to 10)." });
      return;
    }
    const sellerId = typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
    const result = await writeNextDrafts({ sellerId, ...parsed.data });
    res.json({ ok: true, ...result });
  })
);
