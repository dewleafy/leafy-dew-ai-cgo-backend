import { randomUUID } from "crypto";
import { supabase } from "../../db/supabase";

export const MEDIA_BUCKET = "social-media";
export const ALLOWED_MIME: Record<string, "PHOTO" | "VIDEO"> = {
  "image/jpeg": "PHOTO",
  "video/mp4": "VIDEO",
  "video/quicktime": "VIDEO"
};
export const MAX_BYTES = 52428800;

type AssetRow = {
  id: string;
  seller_id: string;
  brand: string;
  kind: "PHOTO" | "VIDEO";
  file_name: string;
  storage_path: string;
  public_url: string;
  mime_type: string;
  size_bytes: number | null;
  note: string | null;
  linked_draft_id: string | null;
  created_at: string;
};

export type SafeAsset = {
  id: string;
  brand: string;
  kind: "PHOTO" | "VIDEO";
  fileName: string;
  publicUrl: string;
  mimeType: string;
  sizeBytes: number | null;
  note: string | null;
  linkedDraftId: string | null;
  createdAt: string;
};

function toSafe(row: AssetRow): SafeAsset {
  return {
    id: row.id,
    brand: row.brand,
    kind: row.kind,
    fileName: row.file_name,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    note: row.note,
    linkedDraftId: row.linked_draft_id,
    createdAt: row.created_at
  };
}

function safeName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(-80) || "file";
}

export async function createUploadUrl(input: { fileName: string; brand: string }) {
  const month = new Date().toISOString().slice(0, 7);
  const brandFolder = safeName(input.brand);
  const path = `${brandFolder}/${month}/${randomUUID()}-${safeName(input.fileName)}`;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(error?.message ?? "Could not prepare the upload.");
  }
  return { path, signedUrl: data.signedUrl };
}

export async function registerAsset(input: {
  sellerId: string;
  brand: string;
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  note: string | null;
}): Promise<SafeAsset> {
  const kind = ALLOWED_MIME[input.mimeType];
  if (!kind) {
    throw new Error("Only JPEG photos and MP4 or MOV videos are allowed.");
  }

  // Confirm the file really is in storage before recording it.
  const folder = input.path.split("/").slice(0, -1).join("/");
  const base = input.path.split("/").pop() ?? "";
  const { data: listing, error: listError } = await supabase.storage.from(MEDIA_BUCKET).list(folder, { search: base, limit: 5 });
  if (listError || !listing?.some((entry) => entry.name === base)) {
    throw new Error("The uploaded file was not found in storage.");
  }

  const { data: publicData } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(input.path);
  const { data, error } = await supabase
    .from("social_media_assets")
    .insert({
      seller_id: input.sellerId,
      brand: input.brand,
      kind,
      file_name: input.fileName,
      storage_path: input.path,
      public_url: publicData.publicUrl,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      note: input.note
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return toSafe(data as AssetRow);
}

export async function listAssets(input: { sellerId: string; limit: number }): Promise<SafeAsset[]> {
  const { data, error } = await supabase
    .from("social_media_assets")
    .select("*")
    .eq("seller_id", input.sellerId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (error) throw new Error(error.message);
  return (data as AssetRow[]).map(toSafe);
}

export async function deleteAsset(input: { sellerId: string; id: string }): Promise<boolean> {
  const { data, error } = await supabase
    .from("social_media_assets")
    .select("*")
    .eq("seller_id", input.sellerId)
    .eq("id", input.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  const row = data as AssetRow;
  await supabase.storage.from(MEDIA_BUCKET).remove([row.storage_path]);
  const { error: delError } = await supabase.from("social_media_assets").delete().eq("id", row.id);
  if (delError) throw new Error(delError.message);
  return true;
}
