import { Request, Response } from "express";
import { z } from "zod";
import {
  ALLOWED_MIME,
  MAX_BYTES,
  createUploadUrl,
  deleteAsset,
  listAssets,
  registerAsset
} from "./social-media.service";

function getSellerId(req: Request): string {
  return typeof req.query.sellerId === "string" && req.query.sellerId.trim() ? req.query.sellerId.trim() : "default";
}

const uploadUrlSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().refine((value) => value in ALLOWED_MIME, "Only JPEG photos and MP4 or MOV videos are allowed."),
  sizeBytes: z.number().int().positive().max(MAX_BYTES, "File is larger than 50 MB."),
  brand: z.string().trim().min(1).max(60).optional().default("Leafy Dew")
});

const registerSchema = z.object({
  path: z.string().trim().min(3).max(300).refine((value) => !value.includes(".."), "Invalid path"),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().refine((value) => value in ALLOWED_MIME, "Unsupported file type."),
  sizeBytes: z.number().int().positive().max(MAX_BYTES).nullable().optional().default(null),
  brand: z.string().trim().min(1).max(60).optional().default("Leafy Dew"),
  note: z.string().trim().max(300).nullable().optional().default(null)
});

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    ok: false,
    message: error.issues[0]?.message ?? "Please check the values.",
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
  });
}

export async function listAssetsController(req: Request, res: Response): Promise<void> {
  const rows = await listAssets({ sellerId: getSellerId(req), limit: 200 });
  res.json({ ok: true, rows });
}

export async function uploadUrlController(req: Request, res: Response): Promise<void> {
  const parsed = uploadUrlSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const result = await createUploadUrl({ fileName: parsed.data.fileName, brand: parsed.data.brand });
  res.json({ ok: true, ...result });
}

export async function registerAssetController(req: Request, res: Response): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  try {
    const row = await registerAsset({ sellerId: getSellerId(req), ...parsed.data });
    res.status(201).json({ ok: true, row });
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : "Could not save the file." });
  }
}

export async function deleteAssetController(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ ok: false, message: "Invalid id." });
    return;
  }
  const done = await deleteAsset({ sellerId: getSellerId(req), id });
  if (!done) {
    res.status(404).json({ ok: false, message: "File not found." });
    return;
  }
  res.json({ ok: true });
}
