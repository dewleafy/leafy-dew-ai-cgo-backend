import { supabase } from "../../db/supabase";
import { getSalesTrafficSummary } from "../sales-traffic/sales-traffic.service";
import { evaluatePlaybooks, PlaybookHit } from "./playbooks.rules";

export type PlaybookProductRow = { asin: string; sku: string | null; productName: string | null; hits: PlaybookHit[] };

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function getWeeklyPlaybooks(sellerId: string) {
  const [ads, econ, returns, traffic] = await Promise.all([
    supabase.from("amazon_ads_advertised_product_daily_metrics").select("advertised_asin, advertised_sku, impressions, clicks, cost, sales, orders").eq("seller_id", sellerId).gte("report_date", daysAgo(7)).limit(5000),
    supabase.from("amazon_product_economics").select("asin, sku, product_name, break_even_acos").eq("seller_id", sellerId).not("asin", "is", null).limit(1000),
    supabase.from("amazon_sp_returns").select("asin, reason, quantity").eq("seller_id", sellerId).gte("return_date", daysAgo(30)).limit(5000),
    getSalesTrafficSummary(sellerId, 7).catch(() => null)
  ]);
  if (ads.error) throw new Error(ads.error.message);
  if (econ.error) throw new Error(econ.error.message);
  if (returns.error) throw new Error(returns.error.message);

  const adAgg = new Map<string, { impressions: number; clicks: number; cost: number; sales: number; orders: number }>();
  for (const r of ads.data ?? []) {
    const k = r.advertised_asin as string | null;
    if (!k) continue;
    const a = adAgg.get(k) ?? { impressions: 0, clicks: 0, cost: 0, sales: 0, orders: 0 };
    a.impressions += Number(r.impressions ?? 0); a.clicks += Number(r.clicks ?? 0); a.cost += Number(r.cost ?? 0); a.sales += Number(r.sales ?? 0); a.orders += Number(r.orders ?? 0);
    adAgg.set(k, a);
  }
  const retAgg = new Map<string, { count: number; reasons: Map<string, number> }>();
  for (const r of returns.data ?? []) {
    const k = r.asin as string | null;
    if (!k) continue;
    const x = retAgg.get(k) ?? { count: 0, reasons: new Map() };
    const q = Number(r.quantity ?? 1) || 1;
    x.count += q;
    const reason = (r.reason as string | null) ?? "";
    if (reason) x.reasons.set(reason, (x.reasons.get(reason) ?? 0) + q);
    retAgg.set(k, x);
  }
  const trafficByAsin = new Map((traffic?.products ?? []).map((p) => [p.asin, p]));

  const products: PlaybookProductRow[] = [];
  for (const e of econ.data ?? []) {
    const asin = e.asin as string;
    const a = adAgg.get(asin);
    const ret = retAgg.get(asin);
    const t = trafficByAsin.get(asin);
    const topReason = ret ? [...ret.reasons.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null : null;
    const hits = evaluatePlaybooks({
      impressions: a?.impressions ?? 0, clicks: a?.clicks ?? 0, adCost: a?.cost ?? 0, adSales: a?.sales ?? 0, adOrders: a?.orders ?? 0,
      breakEvenAcos: e.break_even_acos === null ? null : Number(e.break_even_acos),
      sessions: t?.sessions ?? 0, conversionPct: t?.conversionPct ?? null,
      returns30d: ret?.count ?? 0, topReturnReason: topReason
    });
    if (hits.length) products.push({ asin, sku: e.sku as string | null, productName: e.product_name as string | null, hits });
  }
  const counts: Record<string, number> = {};
  for (const p of products) for (const h of p.hits) counts[h.key] = (counts[h.key] ?? 0) + 1;
  return { counts, products };
}
