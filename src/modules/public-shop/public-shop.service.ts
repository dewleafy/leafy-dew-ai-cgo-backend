import { supabase } from "../../db/supabase";

export type ShopItem = {
  asin: string;
  name: string;
  family: string;
  imageUrl: string | null;
  buyerLink: string;
};

const PREFIXES = [/^leafy\s*dew\s*-\s*connecting people with nature\s*/i, /^leafy\s*dew\s*[-–:]?\s*/i, /^ld\s+/i];

function cleanName(title: string | null, family: string | null): string {
  let name = (title ?? "").replace(/\s+/g, " ").trim();
  for (const prefix of PREFIXES) name = name.replace(prefix, "").trim();
  name = name.replace(/terririum/gi, "Terrarium");

  if (family === "Wall propagation station") {
    const design = name.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
    return design ? `Wall Propagation Station, ${design}` : "Wall Propagation Station";
  }

  name = name.replace(/\s*\|\s*.*$/, "").trim();
  if (name.length > 80) {
    const cut = name.slice(0, 80);
    name = cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,\-–:|]+$/, "").trim();
  }
  return name || "Leafy Dew product";
}

// Public: returns only products marked OK. Never returns SKU, notes or internal status.
export async function getFeaturedAsin(brand: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("social_products")
    .select("asin")
    .eq("seller_id", "default")
    .eq("brand", brand)
    .eq("post_status", "OK")
    .not("featured_at", "is", null)
    .order("featured_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data as { asin: string }[] | null)?.[0]?.asin ?? null;
}

// Owner action: feature one OK product on the shop page, or clear it with null.
export async function setFeaturedProduct(asin: string | null, brand = "Leafy Dew"): Promise<boolean> {
  if (asin === null) {
    const { error } = await supabase
      .from("social_products")
      .update({ featured_at: null })
      .eq("seller_id", "default")
      .eq("brand", brand)
      .not("featured_at", "is", null);
    if (error) throw new Error(error.message);
    return true;
  }
  const { data, error } = await supabase
    .from("social_products")
    .update({ featured_at: new Date().toISOString() })
    .eq("seller_id", "default")
    .eq("brand", brand)
    .eq("asin", asin)
    .eq("post_status", "OK")
    .select("asin");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function listShopItems(brand: string): Promise<ShopItem[]> {
  const { data, error } = await supabase
    .from("social_products")
    .select("asin,title,family,buyer_link")
    .eq("seller_id", "default")
    .eq("brand", brand)
    .eq("post_status", "OK")
    .order("family", { ascending: true })
    .order("title", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { asin: string; title: string | null; family: string | null; buyer_link: string }[];
  const images = new Map<string, string>();
  if (rows.length > 0) {
    const { data: details } = await supabase
      .from("amazon_listing_details")
      .select("asin,image_urls")
      .in("asin", rows.map((row) => row.asin));
    for (const detail of (details ?? []) as { asin: string; image_urls: unknown }[]) {
      const first = Array.isArray(detail.image_urls) ? detail.image_urls[0] : null;
      if (typeof first === "string" && first.startsWith("https://") && !images.has(detail.asin)) {
        images.set(detail.asin, first);
      }
    }
  }

  return rows.map((row) => ({
    asin: row.asin,
    name: cleanName(row.title, row.family),
    family: row.family ?? "Other",
    imageUrl: images.get(row.asin) ?? null,
    buyerLink: row.buyer_link
  }));
}
