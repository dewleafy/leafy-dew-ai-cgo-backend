export type ProductImageStatus = "AVAILABLE" | "MISSING_FROM_SOURCE";

export type NormalizedProductMedia = {
  mainImageUrl: string | null;
  imageUrl: string | null;
  amazonImageUrl: string | null;
  imageSource: string | null;
  lastImageSyncAt: string | null;
  images: string[];
  imageStatus: ProductImageStatus;
};

type ImageCandidate = {
  url: string;
  source: string;
};

type PathSegment = string | number;

const IMAGE_FIELD_NAMES = new Set([
  "mainImageUrl",
  "main_image_url",
  "imageUrl",
  "image_url",
  "productImageUrl",
  "product_image_url",
  "amazonImageUrl",
  "amazon_image_url",
  "images",
  "image_urls",
  "imageUrls",
  "media",
  "attributes",
  "payload",
  "raw",
  "raw_payload",
  "catalog",
  "summaries",
  "includedData"
]);

const PRIORITY_IMAGE_PATHS: PathSegment[][] = [
  ["mainImageUrl"],
  ["main_image_url"],
  ["imageUrl"],
  ["image_url"],
  ["productImageUrl"],
  ["product_image_url"],
  ["amazonImageUrl"],
  ["amazon_image_url"],
  ["summaries", 0, "mainImage", "link"],
  ["summaries", 0, "mainImage", "url"],
  ["images", 0, "images", 0, "link"],
  ["images", 0, "images", 0, "url"],
  ["images", 0, "link"],
  ["images", 0, "url"],
  ["includedData", "images", 0, "images", 0, "link"],
  ["includedData", "images", 0, "images", 0, "url"],
  ["attributes", "main_product_image_locator"],
  ["attributes", "other_product_image_locator_1"],
  ["imageUrls"],
  ["image_urls"],
  ["images"],
  ["media"],
  ["payload"],
  ["raw"],
  ["raw_payload"],
  ["catalog"],
  ["summaries"],
  ["includedData"]
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

export function isValidImageUrl(value: unknown): value is string {
  const text = cleanText(value);
  return Boolean(text && (text.startsWith("https://") || text.startsWith("http://") || text.startsWith("/")));
}

function sourceFromPath(path: PathSegment[]): string {
  return path
    .map((segment) => typeof segment === "number" ? `[${segment}]` : segment)
    .reduce((source, segment) => segment.startsWith("[") ? `${source}${segment}` : source ? `${source}.${segment}` : segment, "");
}

function valueAtPath(value: unknown, path: PathSegment[]): unknown {
  let current = value;

  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }

    if (!isRecord(current)) return undefined;
    current = current[segment];
  }

  return current;
}

function collectImageCandidates(value: unknown, source: string, candidates: ImageCandidate[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;

  if (isValidImageUrl(value)) {
    candidates.push({ url: value.trim(), source });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectImageCandidates(item, `${source}[${index}]`, candidates, depth + 1);
    });
    return;
  }

  if (!isRecord(value)) return;

  for (const key of ["url", "link", "href", "value"]) {
    if (key in value) {
      collectImageCandidates(value[key], `${source}.${key}`, candidates, depth + 1);
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (["url", "link", "href", "value"].includes(key)) continue;
    collectImageCandidates(nestedValue, `${source}.${key}`, candidates, depth + 1);
  }
}

function dedupeCandidates(candidates: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>();
  const unique: ImageCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  return unique;
}

function collectCandidatesFromInput(productOrRaw: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  if (Array.isArray(productOrRaw)) {
    productOrRaw.forEach((item, index) => {
      collectCandidatesFromInput(item).forEach((candidate) => {
        candidates.push({ ...candidate, source: `[${index}].${candidate.source}` });
      });
    });
    return dedupeCandidates(candidates);
  }

  for (const path of PRIORITY_IMAGE_PATHS) {
    const value = valueAtPath(productOrRaw, path);
    if (value !== undefined) {
      collectImageCandidates(value, sourceFromPath(path), candidates);
    }
  }

  return dedupeCandidates(candidates);
}

export function normalizeProductImage(productOrRaw: unknown): string | null {
  return collectCandidatesFromInput(productOrRaw)[0]?.url ?? null;
}

export function normalizeProductMedia(
  productOrRaw: unknown,
  options: { lastImageSyncAt?: string | null; amazonImagePreferred?: boolean } = {}
): NormalizedProductMedia {
  const candidates = collectCandidatesFromInput(productOrRaw);
  const first = candidates[0] ?? null;
  const images = candidates.map((candidate) => candidate.url);
  const amazonCandidate = candidates.find((candidate) => (
    candidate.source.toLowerCase().includes("amazon") ||
    candidate.source.toLowerCase().includes("raw") ||
    candidate.source.toLowerCase().includes("summaries") ||
    candidate.source.toLowerCase().includes("includeddata") ||
    candidate.source.toLowerCase().includes("main_image_url")
  )) ?? (options.amazonImagePreferred ? first : null);
  const mainImageUrl = first?.url ?? null;

  return {
    mainImageUrl,
    imageUrl: mainImageUrl,
    amazonImageUrl: amazonCandidate?.url ?? null,
    imageSource: first?.source ?? null,
    lastImageSyncAt: mainImageUrl ? options.lastImageSyncAt ?? null : null,
    images,
    imageStatus: mainImageUrl ? "AVAILABLE" : "MISSING_FROM_SOURCE"
  };
}

export function availableImageFields(productOrRaw: unknown): string[] {
  const fields = new Set<string>();

  function visit(value: unknown, path: string, depth: number): void {
    if (depth > 5 || value === null || value === undefined || fields.size >= 40) return;

    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }

    if (!isRecord(value)) return;

    for (const [key, nestedValue] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;

      if (IMAGE_FIELD_NAMES.has(key) || isValidImageUrl(nestedValue)) {
        fields.add(nextPath);
      }

      if (
        IMAGE_FIELD_NAMES.has(key) ||
        key.toLowerCase().includes("image") ||
        key.toLowerCase().includes("media") ||
        key === "payload" ||
        key === "raw" ||
        key === "raw_payload" ||
        key === "catalog" ||
        key === "summaries" ||
        key === "includedData" ||
        key === "attributes"
      ) {
        visit(nestedValue, nextPath, depth + 1);
      }
    }
  }

  visit(productOrRaw, "", 0);
  return Array.from(fields);
}
