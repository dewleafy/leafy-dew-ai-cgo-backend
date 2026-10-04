// Turns one Amazon Listings Items API response into a clean, complete listing record, and scores
// how complete the listing is. Pure functions.
type AttrValue = { value?: unknown; media_location?: unknown; [k: string]: unknown };
export type Attrs = Record<string, AttrValue[] | undefined>;

export type ListingIssue = { code?: string; message?: string; severity?: string; attributeNames?: string[] };

export type ListingApiResponse = {
  attributes?: Attrs;
  summaries?: Array<{ asin?: string; productType?: string; itemName?: string; status?: string[]; mainImage?: { link?: string } }>;
  issues?: ListingIssue[];
  offers?: Array<{ price?: { amount?: string | number } }>;
  fulfillmentAvailability?: Array<{ quantity?: number }>;
  relationships?: Array<{ relationships?: Array<{ type?: string; parentSkus?: string[]; parentAsins?: string[] }> }>;
};

export type ListingDetails = {
  title: string | null;
  brand: string | null;
  productType: string | null;
  asin: string | null;
  listingStatus: string[];
  bullets: string[];
  description: string | null;
  genericKeywords: string | null;
  imageUrls: string[];
  price: number | null;
  quantity: number | null;
  parentAsin: string | null;
  issues: ListingIssue[];
  errorIssueCount: number;
};

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

function firstValue(attrs: Attrs | undefined, key: string): string | null {
  const list = attrs?.[key];
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const t = text(item?.value);
    if (t) return t;
  }
  return null;
}

export function extractListingDetails(r: ListingApiResponse): ListingDetails {
  const a = r.attributes;
  const summary = r.summaries?.[0];
  const bullets = (a?.["bullet_point"] ?? []).map((x) => text(x?.value)).filter((x): x is string => !!x);
  const images: string[] = [];
  const main = a?.["main_product_image_locator"]?.map((x) => text(x?.media_location)).find(Boolean) ?? summary?.mainImage?.link ?? null;
  if (main) images.push(main);
  for (let i = 1; i <= 8; i += 1) {
    const url = a?.[`other_product_image_locator_${i}`]?.map((x) => text(x?.media_location)).find(Boolean);
    if (url) images.push(url);
  }
  let price: number | null = null;
  const offerPrice = r.offers?.[0]?.price?.amount;
  if (offerPrice !== undefined && Number.isFinite(Number(offerPrice))) price = Number(offerPrice);
  const quantity = r.fulfillmentAvailability?.[0]?.quantity;
  const parentAsin = r.relationships?.[0]?.relationships?.find((x) => x.type === "VARIATION")?.parentAsins?.[0] ?? null;
  const issues = Array.isArray(r.issues) ? r.issues : [];
  return {
    title: firstValue(a, "item_name") ?? summary?.itemName ?? null,
    brand: firstValue(a, "brand"),
    productType: summary?.productType ?? null,
    asin: summary?.asin ?? null,
    listingStatus: summary?.status ?? [],
    bullets,
    description: firstValue(a, "product_description"),
    genericKeywords: firstValue(a, "generic_keyword"),
    imageUrls: images,
    price,
    quantity: typeof quantity === "number" ? quantity : null,
    parentAsin,
    issues,
    errorIssueCount: issues.filter((i) => (i.severity ?? "").toUpperCase() === "ERROR").length
  };
}

export type Completeness = { score: number; missing: string[] };

export function scoreListingCompleteness(d: ListingDetails): Completeness {
  const checks: Array<[string, boolean]> = [
    ["Title", !!d.title && d.title.length >= 60],
    ["5 bullet points", d.bullets.length >= 5],
    ["Description", !!d.description && d.description.length >= 100],
    ["Backend search terms", !!d.genericKeywords],
    ["Brand", !!d.brand],
    ["Product type", !!d.productType],
    ["Main image", d.imageUrls.length >= 1],
    ["7+ images", d.imageUrls.length >= 7],
    ["Price", d.price !== null],
    ["No Amazon errors", d.errorIssueCount === 0]
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { score: Math.round(((checks.length - missing.length) / checks.length) * 100), missing };
}
