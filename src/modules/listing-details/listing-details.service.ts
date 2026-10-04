import { supabase } from "../../db/supabase";

export async function getListingDetailsSummary(sellerId: string) {
  const { data, error } = await supabase
    .from("amazon_listing_details")
    .select("sku, asin, title, brand, product_type, listing_status, image_count, issue_count, error_issue_count, price, completeness_score, missing_fields, last_fetched_at, fetch_error")
    .eq("seller_id", sellerId)
    .order("completeness_score", { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);
  const all = data ?? [];
  const rows = all.filter((r) => !r.fetch_error);
  const notFound = all.filter((r) => r.fetch_error);
  const missingCounts: Record<string, number> = {};
  for (const r of rows) for (const m of (r.missing_fields as string[] | null) ?? []) missingCounts[m] = (missingCounts[m] ?? 0) + 1;
  const { count } = await supabase.from("amazon_sp_listings").select("id", { count: "exact", head: true }).eq("seller_id", sellerId);
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + Number(r.completeness_score ?? 0), 0) / rows.length) : null;
  return {
    totalListings: count ?? 0,
    fetched: rows.length,
    averageCompleteness: avg,
    fullyComplete: rows.filter((r) => Number(r.completeness_score) === 100).length,
    notFoundOnAmazon: notFound.map((r) => r.sku),
    withErrors: rows.filter((r) => Number(r.error_issue_count) > 0).length,
    missingCounts,
    rows
  };
}
