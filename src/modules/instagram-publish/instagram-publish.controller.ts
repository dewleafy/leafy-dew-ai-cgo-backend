import { Request, Response } from "express";
import { z } from "zod";
import { getInstagramStatus, publishInstagramTestPhoto } from "./instagram-publish.service";

const testPostSchema = z.object({
  imageUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith("https://"), "Image URL must start with https://")
    .refine((value) => /\.(jpe?g)(\?.*)?$/i.test(value), "Instagram needs a JPEG image (.jpg or .jpeg)"),
  caption: z.string().trim().min(1).max(2200),
  confirm: z.literal("POST_NOW"),
  sellerId: z.string().trim().min(1).optional().default("default")
});

export async function instagramStatusController(_req: Request, res: Response): Promise<void> {
  const status = await getInstagramStatus();
  res.json({ ok: true, ...status });
}

export async function instagramTestPostController(req: Request, res: Response): Promise<void> {
  const parsed = testPostSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: "Please check the test post values. The confirm field must be exactly POST_NOW.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return;
  }

  try {
    const result = await publishInstagramTestPhoto({
      imageUrl: parsed.data.imageUrl,
      caption: parsed.data.caption,
      sellerId: parsed.data.sellerId
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "Could not publish the test post."
    });
  }
}
