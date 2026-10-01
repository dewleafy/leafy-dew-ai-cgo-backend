import { supabase } from "../../db/supabase";
import { getSalesTrafficSummary } from "../sales-traffic/sales-traffic.service";
import { decideStrategy, StrategyResult } from "./strategy.rules";

export type StrategyRow = StrategyResult & {
  sku: string | null;
  asin: string | null;
  productName: string | null;
  sessions: number;
  unitsOrdered: number;
  flags: string[];
};

const ORDER: Record<string, number> = { LOSING_MONEY: 0, INVESTIGATE: 1, FIX_LISTING: 2, FIX_COSTS: 3, ORGANIC_ONLY: 4, HOLD: 5, PUSH: 6 };

export async function getWeeklyStrategy(sellerId: string): Promise<{ counts: Record<string, number>; products: StrategyRow[] }> {
  const { data, error } = await supabase
    .from("amazon_product_economics")
    .select("sku, asin, product_name, profit_status, target_acos, break_even_acos")
    .eq("seller_id", sellerId)
    .not("asin", "is", null)
    .limit(500);
  if (error) throw new Error(error.message);

  const traffic = await getSalesTrafficSummary(sellerId, 7).catch(() => null);
  const byAsin = new Map((traffic?.products ?? []).map((p) => [p.asin, p]));

  const products: StrategyRow[] = (data ?? []).map((r) => {
    const t = r.asin ? byAsin.get(r.asin as string) : undefined;
    const flags = t?.flags ?? [];
    const result = decideStrategy({
      profitStatus: (r.profit_status as string | null) ?? null,
      targetAcos: r.target_acos === null ? null : Number(r.target_acos),
      breakEvenAcos: r.break_even_acos === null ? null : Number(r.break_even_acos),
      flags,
      sessions: t?.sessions ?? 0
    });
    return { ...result, sku: r.sku as string | null, asin: r.asin as string | null, productName: r.product_name as string | null, sessions: t?.sessions ?? 0, unitsOrdered: t?.unitsOrdered ?? 0, flags };
  });
  products.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);

  const counts: Record<string, number> = {};
  for (const p of products) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
  return { counts, products };
}
