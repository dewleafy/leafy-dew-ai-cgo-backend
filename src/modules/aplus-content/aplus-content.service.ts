import { supabase } from "../../db/supabase";
import { requireConnectedConnection } from "../amazon-sp/amazon-sp.service";
import { amazonSpGet } from "../amazon-sp/amazon-sp-client.service";
import { getAmazonSpAccessToken } from "../amazon-sp/amazon-sp-token.service";
import {
  AplusContentCacheRow,
  AplusContentReport,
  AplusContentStatus,
  NormalizedAplusBlock,
  NormalizedAplusModule
} from "./aplus-content.types";

const CACHE_MAX_AGE_DAYS = 7;

// Amazon's A+ Content API represents plain "headline" style text as a TextComponent
// ({ value: string }) but represents "body" style text as a richer ParagraphComponent
// ({ textList: [{ value: string }, ...] }). The previous version of this function only
// ever unwrapped the TextComponent shape, so body copy silently never rendered for
// ANY module type — this was the single biggest reason A+ modules looked empty.
function extractText(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;

  if (typeof record.value === "string" && record.value.trim()) {
    return record.value.trim();
  }

  if (Array.isArray(record.textList)) {
    const parts = record.textList
      .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).value : undefined))
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (parts.length > 0) return parts.join(" ");
  }

  return undefined;
}

function extractImageUrl(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  for (const key of ["src", "url", "link"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Amazon's A+ Content API returns images as an internal storage path
  // ("uploadDestinationId"), not a direct URL — build the real CDN URL from it.
  const uploadDestinationId = record["uploadDestinationId"];
  if (typeof uploadDestinationId === "string" && uploadDestinationId.trim()) {
    return `https://m.media-amazon.com/images/S/${uploadDestinationId.trim()}`;
  }
  return undefined;
}

// Unconditional safety net: walk the ENTIRE module content tree, regardless of key
// names, and collect every image found anywhere. This guarantees no image Amazon
// actually sent is ever dropped just because it sits under a key name the structural
// walker below doesn't happen to recognize.
function deepCollectImages(node: unknown, seen: Set<string>, out: string[], depth = 0) {
  if (depth > 8 || !node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const entry of node) deepCollectImages(entry, seen, out, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const url = extractImageUrl(record);
  if (url && !seen.has(url)) {
    seen.add(url);
    out.push(url);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") deepCollectImages(value, seen, out, depth + 1);
  }
}

// Amazon has ~20 different A+ module types, each with its own nested shape. Rather
// than hand-writing a parser per type, this walks any module's content object looking
// for headline/body/image-shaped fields at any depth, plus repeated sub-blocks (image
// grids, comparison rows, feature lists) — producing one common shape every module
// type can be rendered from. Any nested object we don't specifically recognize is
// still treated as a candidate sub-block and recursed into, rather than being skipped:
// Amazon's ~20 module types don't share one container-naming convention (block1..4,
// a single "block", comparison rows, spec lists, ...), so gating recursion behind a
// fixed whitelist of key names silently dropped whichever module types didn't match.
function walkModuleContent(content: Record<string, unknown>, depth = 0): {
  headline?: string;
  body?: string;
  images: string[];
  items: NormalizedAplusBlock[];
} {
  let headline: string | undefined;
  let body: string | undefined;
  const images: string[] = [];
  const items: NormalizedAplusBlock[] = [];

  if (depth > 4) return { headline, body, images, items };

  for (const [key, value] of Object.entries(content)) {
    const lowerKey = key.toLowerCase();
    if (!value || typeof value !== "object") continue;

    if (lowerKey.includes("headline") && !headline) {
      const text = extractText(value);
      if (text) headline = text;
      continue;
    }

    if ((lowerKey.includes("body") || lowerKey.includes("description") || lowerKey === "text") && !body) {
      const text = extractText(value);
      if (text) body = text;
      continue;
    }

    if (lowerKey.includes("image") || lowerKey.includes("logo")) {
      const url = extractImageUrl(value);
      if (url) images.push(url);
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          const sub = walkModuleContent(entry as Record<string, unknown>, depth + 1);
          if (sub.headline || sub.body || sub.images.length > 0) {
            items.push({ headline: sub.headline, body: sub.body, image: sub.images[0] });
          }
          for (const extra of sub.images.slice(1)) images.push(extra);
          for (const nested of sub.items) items.push(nested);
        }
      }
      continue;
    }

    // Any other nested object — block1/block2/block, a comparison row, a spec list,
    // whatever this particular module type calls it — is a candidate content block.
    const sub = walkModuleContent(value as Record<string, unknown>, depth + 1);
    if (sub.headline || sub.body || sub.images.length > 0) {
      items.push({ headline: sub.headline, body: sub.body, image: sub.images[0] });
    }
    for (const extra of sub.images.slice(1)) images.push(extra);
    for (const nested of sub.items) items.push(nested);
  }

  return { headline, body, images, items };
}

function normalizeModule(rawModule: Record<string, unknown>): NormalizedAplusModule {
  const type = typeof rawModule.contentModuleType === "string" ? rawModule.contentModuleType : "UNKNOWN";
  const contentKey = Object.keys(rawModule).find((key) => key !== "contentModuleType");
  const content = contentKey ? rawModule[contentKey] : undefined;
  const walked = content && typeof content === "object"
    ? walkModuleContent(content as Record<string, unknown>)
    : { headline: undefined, body: undefined, images: [] as string[], items: [] as NormalizedAplusBlock[] };

  // Safety net: also do an unconditional deep scan for every image anywhere in the
  // module, and fold in anything the structural walk above missed.
  const deepImages: string[] = [];
  if (content && typeof content === "object") {
    deepCollectImages(content, new Set<string>(), deepImages);
  }

  const usedImages = new Set(walked.items.map((item) => item.image).filter((value): value is string => Boolean(value)));
  const finalImages: string[] = [];
  const seenImages = new Set<string>();
  for (const url of [...walked.images, ...deepImages]) {
    if (usedImages.has(url) || seenImages.has(url)) continue;
    seenImages.add(url);
    finalImages.push(url);
  }

  const isEmpty = !walked.headline && !walked.body && finalImages.length === 0 && walked.items.length === 0;

  return {
    type,
    headline: walked.headline,
    body: walked.body,
    images: finalImages,
    items: walked.items,
    debugKeys: isEmpty && content && typeof content === "object" ? Object.keys(content as Record<string, unknown>) : undefined
  };
}

async function getCachedAplusContent(sellerId: string, asin: string): Promise<AplusContentCacheRow | null> {
  const { data, error } = await supabase
    .from("amazon_aplus_content_cache")
    .select("*")
    .eq("seller_id", sellerId)
    .eq("asin", asin)
    .maybeSingle();

  if (error || !data) return null;

  // Only trust the cache for a genuine, successful find with real content. A "not
  // found" or empty-modules result might reflect a bug or permission issue rather
  // than reality — never let that silently hide behind a multi-day cache.
  const hasRealContent = data.status !== "NOT_FOUND" && Array.isArray(data.content_module_list) && data.content_module_list.length > 0;
  if (!hasRealContent) return null;

  const ageMs = Date.now() - new Date(data.fetched_at).getTime();
  const maxAgeMs = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) return null;

  return data as AplusContentCacheRow;
}

async function fetchAndCacheAplusContent(sellerId: string, asin: string): Promise<{ row: AplusContentCacheRow; diagnostic?: string }> {
  const connection = await requireConnectedConnection(sellerId);
  const accessToken = await getAmazonSpAccessToken(connection.id);

  const publishRecords = await amazonSpGet<Record<string, unknown>>({
    path: "/aplus/2020-11-01/contentPublishRecords",
    query: { asin, marketplaceId: connection.marketplace_id },
    accessToken,
    region: connection.region,
    stage: "GET_APLUS_PUBLISH_RECORDS"
  });

  const recordList = (publishRecords?.contentPublishRecordList ?? publishRecords?.publishRecordList) as
    | Array<{ contentMetadataRecord?: { contentReferenceKey?: string }; contentReferenceKey?: string }>
    | undefined;
  const firstRecord = Array.isArray(recordList) ? recordList[0] : undefined;
  const contentReferenceKey = firstRecord?.contentMetadataRecord?.contentReferenceKey ?? firstRecord?.contentReferenceKey;

  if (!contentReferenceKey) {
    const now = new Date().toISOString();
    const dbRow = {
      seller_id: sellerId,
      asin,
      content_reference_key: null,
      status: "NOT_FOUND" as AplusContentStatus,
      content_module_list: [],
      fetched_at: now,
      updated_at: now
    };
    await supabase.from("amazon_aplus_content_cache").upsert(dbRow, { onConflict: "seller_id,asin" });
    const diagnosticKeys = publishRecords && typeof publishRecords === "object" ? Object.keys(publishRecords) : [];
    const diagnostic = `Diagnostic — Amazon's response top-level keys: [${diagnosticKeys.join(", ") || "(empty object)"}]. Raw (first 500 chars): ${JSON.stringify(publishRecords).slice(0, 500)}`;
    return { row: { id: "", created_at: now, ...dbRow }, diagnostic };
  }

  const document = await amazonSpGet<Record<string, unknown>>({
    path: `/aplus/2020-11-01/contentDocuments/${encodeURIComponent(contentReferenceKey)}`,
    query: { marketplaceId: connection.marketplace_id, includedDataSet: ["CONTENTS"] },
    accessToken,
    region: connection.region,
    stage: "GET_APLUS_CONTENT_DOCUMENT"
  });

  const contentRecord = document?.contentRecord as Record<string, unknown> | undefined;
  const contentDocument = (contentRecord?.contentDocument ?? document?.contentDocument) as Record<string, unknown> | undefined;
  const rawModules = (contentDocument?.contentModuleList ?? document?.contentModuleList ?? []) as Array<Record<string, unknown>>;
  const modules = rawModules.map((module) => normalizeModule(module));
  const status: AplusContentStatus = (contentDocument?.status as AplusContentStatus) ?? "FOUND";
  const now = new Date().toISOString();

  const row = {
    seller_id: sellerId,
    asin,
    content_reference_key: contentReferenceKey,
    status,
    content_module_list: modules,
    fetched_at: now,
    updated_at: now
  };

  await supabase.from("amazon_aplus_content_cache").upsert(row, { onConflict: "seller_id,asin" });

  let diagnostic: string | undefined;
  if (modules.length === 0) {
    const docKeys = document && typeof document === "object" ? Object.keys(document) : [];
    const contentDocKeys = contentDocument && typeof contentDocument === "object" ? Object.keys(contentDocument) : [];
    diagnostic = `Diagnostic — a content reference was found (${contentReferenceKey}), but no modules were parsed from the document. Response top-level keys: [${docKeys.join(", ") || "(empty)"}]. contentDocument keys: [${contentDocKeys.join(", ") || "(none)"}]. Raw (first 500 chars): ${JSON.stringify(document).slice(0, 500)}`;
  }

  return { row: row as AplusContentCacheRow, diagnostic };
}

export async function getAplusContentPreview(input: { sellerId: string; asin: string }): Promise<AplusContentReport> {
  const { sellerId, asin } = input;

  if (!asin) {
    throw new Error("This product has no ASIN on file yet, so A+ Content can't be looked up.");
  }

  const cached = await getCachedAplusContent(sellerId, asin);
  if (cached) {
    return {
      ok: true,
      asin,
      status: cached.status,
      moduleCount: cached.content_module_list.length,
      modules: cached.content_module_list,
      fetchedAt: cached.fetched_at,
      source: "CACHED"
    };
  }

  try {
    const { row: fresh, diagnostic } = await fetchAndCacheAplusContent(sellerId, asin);
    return {
      ok: true,
      asin,
      status: fresh.status,
      moduleCount: fresh.content_module_list.length,
      modules: fresh.content_module_list,
      fetchedAt: fresh.fetched_at,
      source: "FETCHED_LIVE",
      warning: diagnostic
    };
  } catch (error) {
    return {
      ok: true,
      asin,
      status: "NOT_FOUND",
      moduleCount: 0,
      modules: [],
      fetchedAt: new Date().toISOString(),
      source: "FETCHED_LIVE",
      warning: error instanceof Error ? error.message : "Could not reach Amazon's A+ Content API."
    };
  }
}
