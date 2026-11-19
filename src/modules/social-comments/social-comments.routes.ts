import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/async-handler";
import { ignoreComment, listComments, sendReply, syncComments } from "./social-comments.service";

export const socialCommentsRouter = Router();

socialCommentsRouter.get("/", asyncHandler(async (_req, res) => {
  res.json({ ok: true, rows: await listComments() });
}));

// Reads new comments and drafts replies. Posts nothing.
socialCommentsRouter.post("/sync", asyncHandler(async (_req, res) => {
  try {
    const result = await syncComments();
    res.json({ ok: true, ...result, rows: await listComments() });
  } catch (e) {
    res.status(502).json({ ok: false, message: e instanceof Error ? e.message : "Could not read comments." });
  }
}));

socialCommentsRouter.post("/:id/ignore", asyncHandler(async (req, res) => {
  await ignoreComment(String(req.params.id));
  res.json({ ok: true });
}));

// Posts the reply to Instagram. Only runs when the owner presses Send.
socialCommentsRouter.post("/:id/send", asyncHandler(async (req, res) => {
  const parsed = z.object({ reply: z.string().min(1).max(300) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, message: "Reply must be 1 to 300 characters." }); return; }
  try {
    await sendReply(String(req.params.id), parsed.data.reply);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, message: e instanceof Error ? e.message : "Could not send the reply." });
  }
}));
