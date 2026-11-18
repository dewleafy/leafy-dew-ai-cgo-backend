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
  name = name.replace(/terririum/gi, "Terrarium").replace(/connecting people with nature\s*/gi, "").trim();

  if (family === "Wall propagation station") {
    const design = name.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
    return design ? `Wall Propagation Station, ${design}` : "Wall Propagation Station";
  }

  // The last bracket is usually the variant (colour, design). Size and pack brackets are not.
  let variant: string | null = null;
  const tail = name.match(/\(([^()]+)\)\s*$/);
  if (tail && !/\b(pack of|set of|inch|inches|tealight candles)\b/i.test(tail[1])) {
    variant = tail[1].trim();
    name = name.slice(0, tail.index).trim();
  }
  const code = name.match(/\s*(L-D-C-G-P-\d+)\s*$/i);
  if (code) {
    if (!variant) variant = code[1];
    name = name.slice(0, code.index).trim();
  }

  name = name.replace(/\s*\|\s*.*$/, "").replace(/\s*\([^)]*(pack of|set of|inch)[^)]*\)\s*/gi, " ").replace(/\s+/g, " ").trim();
  if (name.length > 62) {
    const cut = name.slice(0, 62);
    name = cut.slice(0, Math.max(cut.lastIndexOf(" "), 36)).replace(/[,\-–:|]+$/, "").trim();
    name = name.replace(/(\s+(with|and|for|of|the|a|in|on|to|fairy|white|warm))+$/i, "").replace(/[,\-–:|]+$/, "").trim();
  }
  name = name.replace(/^\(\s*\d+\s*inch\)\s*/i, "").trim() || "Leafy Dew product";
  return variant ? `${name} (${variant})` : name;
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
