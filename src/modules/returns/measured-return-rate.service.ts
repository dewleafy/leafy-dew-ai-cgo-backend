import { supabase } from "../../db/supabase";

// Measured (not assumed) return rate per product: units returned / units sold over a window,
// from the synced Amazon orders and returns tables. Product Economics only holds an ASSUMED
// return-rate input; this is the real number, used by the PPC guardrails and shown to the founder.

export const RETURN_LOOKBACK_DAYS = 90;
/** Below this many units sold the rate is noise, so no verdict is given. */
export const RETURN_MIN_UNITS = 8;
/** At or above this share of units returned a product is a return risk. */
export const RETURN_RISK_RATE_PCT = 15;

export type MeasuredReturnRate = {
  asin: string;
  sku: string | null;
  unitsSold: number;
  unitsReturned: number;
  returnRatePercent: number;
  /** True once enough units were sold for the percentage to mean something. */
  enoughData: boolean;
  isReturnRisk: boolean;
  /** Most common Amazon return reasons, most frequent first. */
  topReasons: Array<{ reason: string; units: number }>;
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getMeasuredReturnRates(
  sellerId: string,
  options: { asins?: string[]; days?: number } = {}
): Promise<MeasuredReturnRate[]> {
  const days = options.days ?? RETURN_LOOKBACK_DAYS;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const wanted = options.asins ? options.asins.map((a) => a.trim().toUpperCase()).filter(Boolean) : null;
  if (wanted && wanted.length === 0) return [];

  const { data: orders, error: ordersError } = await supabase
    .from("amazon_sp_orders")
    .select("amazon_order_id")
    .eq("seller_id", sellerId)
    .gte("purchase_date", since)
    .limit(5000);
  if (ordersError) throw ordersError;

  const orderIds = ((orders ?? []) as { amazon_order_id: string | null }[])
    .map((row) => row.amazon_order_id)
    .filter((id): id is string => Boolean(id));

  const sold = new Map<string, { units: number; sku: string | null }>();
  for (let i = 0; i < orderIds.length; i += 100) {
    let query = supabase
      .from("amazon_sp_order_items")
      .select("asin, sku, quantity_ordered")
      .in("amazon_order_id", orderIds.slice(i, i + 100));
    if (wanted) query = query.in("asin", wanted);
    const { data: items, error: itemsError } = await query;
    if (itemsError) throw itemsError;
    for (const item of (items ?? []) as { asin: string | null; sku: string | null; quantity_ordered: unknown }[]) {
      const asin = String(item.asin ?? "").trim().toUpperCase();
      if (!asin) continue;
      const current = sold.get(asin) ?? { units: 0, sku: null };
      current.units += num(item.quantity_ordered);
      current.sku = current.sku ?? (item.sku ? String(item.sku) : null);
      sold.set(asin, current);
    }
  }

  let returnsQuery = supabase
    .from("amazon_sp_returns")
    .select("asin, sku, quantity, reason")
    .eq("seller_id", sellerId)
    .gte("return_date", since)
    .limit(5000);
  if (wanted) returnsQuery = returnsQuery.in("asin", wanted);
  const { data: returns, error: returnsError } = await returnsQuery;
  if (returnsError) throw returnsError;

  const returned = new Map<string, { units: number; sku: string | null; reasons: Map<string, number> }>();
  for (const row of (returns ?? []) as { asin: string | null; sku: string | null; quantity: unknown; reason: string | null }[]) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (!asin) continue;
    const units = num(row.quantity) || 1;
    const current = returned.get(asin) ?? { units: 0, sku: null, reasons: new Map<string, number>() };
    current.units += units;
    current.sku = current.sku ?? (row.sku ? String(row.sku) : null);
    const reason = row.reason ? String(row.reason) : "UNKNOWN";
    current.reasons.set(reason, (current.reasons.get(reason) ?? 0) + units);
    returned.set(asin, current);
  }

  const asins = new Set([...sold.keys(), ...returned.keys()]);
  const result: MeasuredReturnRate[] = [];
  for (const asin of asins) {
    const s = sold.get(asin);
    const r = returned.get(asin);
    const unitsSold = s?.units ?? 0;
    const unitsReturned = r?.units ?? 0;
    const ratePct = unitsSold > 0 ? Math.round((unitsReturned / unitsSold) * 10000) / 100 : 0;
    const enoughData = unitsSold >= RETURN_MIN_UNITS;
    result.push({
      asin,
      sku: s?.sku ?? r?.sku ?? null,
      unitsSold,
      unitsReturned,
      returnRatePercent: ratePct,
      enoughData,
      isReturnRisk: enoughData && ratePct >= RETURN_RISK_RATE_PCT,
      topReasons: r
        ? [...r.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, units]) => ({ reason, units }))
        : []
    });
  }

  return result.sort((a, b) => b.returnRatePercent - a.returnRatePercent || b.unitsSold - a.unitsSold);
}
