import { supabase } from "../../db/supabase";
import { getMeasuredReturnRates, RETURN_MIN_UNITS } from "../returns/measured-return-rate.service";

// READ-ONLY preview: what each product's profit status would become if its ASSUMED return rate
// were replaced by the MEASURED one. Nothing is written. Rules agreed with the founder:
//  - measured rate is used only with >= RETURN_MIN_UNITS units sold in the last 90 days
//  - a rate the founder typed himself wins (only the old/new defaults 10 and 25 count as "assumed")
//  - the return reserve is linear in rate/(1-rate), so the cost per return is recovered from the
//    stored reserve and re-applied at the measured rate; max allowable ad spend moves by the same amount

const ASSUMED_DEFAULT_RATES = [10, 25];

export type ReturnRatePreviewRow = {
  id: string;
  newRatePercent: number | null;
  newReserve: number | null;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  assumedRatePercent: number;
  measuredRatePercent: number | null;
  unitsSold: number;
  unitsReturned: number;
  decision: "USE_MEASURED" | "KEEP_FOUNDER_RATE" | "KEEP_ASSUMED_NOT_ENOUGH_DATA" | "KEEP_ASSUMED_NO_ORDERS" | "CANNOT_RECOMPUTE";
  currentStatus: string;
  newStatus: string;
  currentMaxAdSpend: number;
  newMaxAdSpend: number;
  currentTargetAcos: number;
  newTargetAcos: number;
  statusChanges: boolean;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function getReturnRatePreview(sellerId: string) {
  const { data, error } = await supabase.from("amazon_product_economics").select("*").eq("seller_id", sellerId);
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  const measured = await getMeasuredReturnRates(sellerId);
  const byAsin = new Map(measured.filter((m) => m.asin).map((m) => [m.asin.toUpperCase(), m]));
  const bySku = new Map(measured.filter((m) => m.sku).map((m) => [String(m.sku), m]));

  const out: ReturnRatePreviewRow[] = rows.map((row: any) => {
    const asin = row.asin ? String(row.asin).toUpperCase() : null;
    const m = (asin && byAsin.get(asin)) || (row.sku && bySku.get(String(row.sku))) || null;
    const assumed = num(row.return_rate_percent);
    const price = num(row.selling_price);
    const curMax = num(row.max_allowable_ad_spend);
    const curStatus = String(row.profit_status ?? "NEEDS_INPUT");
    const base = {
      id: String(row.id),
      newRatePercent: null as number | null,
      newReserve: null as number | null,
      sku: row.sku ?? null,
      asin: row.asin ?? null,
      productName: row.product_name ?? null,
      assumedRatePercent: assumed,
      measuredRatePercent: m ? m.returnRatePercent : null,
      unitsSold: m?.unitsSold ?? 0,
      unitsReturned: m?.unitsReturned ?? 0,
      currentStatus: curStatus,
      currentMaxAdSpend: curMax,
      currentTargetAcos: num(row.target_acos)
    };
    const keep = (decision: ReturnRatePreviewRow["decision"]): ReturnRatePreviewRow => ({
      ...base, decision, newStatus: curStatus, newMaxAdSpend: curMax, newTargetAcos: base.currentTargetAcos, statusChanges: false
    });

    if (!m) return keep("KEEP_ASSUMED_NO_ORDERS");
    if (!m.enoughData) return keep("KEEP_ASSUMED_NOT_ENOUGH_DATA");
    if (!ASSUMED_DEFAULT_RATES.includes(assumed)) return keep("KEEP_FOUNDER_RATE");
    if (!["PASS", "BLOCKED"].includes(curStatus) || price <= 0) return keep("CANNOT_RECOMPUTE");

    const oldReserve = num(row.return_reserve_per_unit);
    const oldFactor = assumed / 100 / (1 - assumed / 100);
    const costPerReturn = oldFactor > 0 ? oldReserve / oldFactor : 0;
    const rate = Math.min(Math.max(m.returnRatePercent, 0), 99.9) / 100;
    const newReserve = costPerReturn * (rate / (1 - rate));
    const newMax = r2(curMax - (newReserve - oldReserve));
    const newStatus = newMax <= 0 ? "BLOCKED" : "PASS";
    return {
      ...base,
      decision: "USE_MEASURED",
      newRatePercent: m.returnRatePercent,
      newReserve: r2(newReserve),
      newStatus,
      newMaxAdSpend: newMax,
      newTargetAcos: r2((newMax / price) * 100),
      statusChanges: newStatus !== curStatus
    };
  });

  const order = (r: ReturnRatePreviewRow) => (r.statusChanges ? 0 : r.decision === "USE_MEASURED" ? 1 : 2);
  out.sort((a, b) => order(a) - order(b));
  return {
    minUnitsForVerdict: RETURN_MIN_UNITS,
    summary: {
      products: out.length,
      usingMeasured: out.filter((r) => r.decision === "USE_MEASURED").length,
      statusWouldChange: out.filter((r) => r.statusChanges).length,
      keptFounderRate: out.filter((r) => r.decision === "KEEP_FOUNDER_RATE").length
    },
    rows: out
  };
}

const BACKUP_TABLE = "product_economics_return_rate_backups";

/** Writes the measured rate into the products the preview marked USE_MEASURED. Old values are saved for undo. */
export async function applyReturnRateSwitch(sellerId: string) {
  const preview = await getReturnRatePreview(sellerId);
  const targets = preview.rows.filter((r) => r.decision === "USE_MEASURED" && r.newRatePercent !== null);
  const applied: string[] = [];
  for (const t of targets) {
    const { data: row, error } = await supabase.from("amazon_product_economics").select("*").eq("id", t.id).single();
    if (error || !row) throw new Error(error?.message ?? "row missing");
    const price = num(row.selling_price);
    const delta = (t.newReserve ?? 0) - num(row.return_reserve_per_unit);
    const nonAd = r2(num(row.non_ad_cost) + delta);
    const patch = {
      return_rate_percent: t.newRatePercent,
      return_reserve_per_unit: t.newReserve,
      non_ad_cost: nonAd,
      max_allowable_ad_spend: t.newMaxAdSpend,
      target_acos: t.newTargetAcos,
      break_even_acos: price > 0 ? r2(((price - nonAd) / price) * 100) : row.break_even_acos,
      profit_status: t.newStatus,
      updated_at: new Date().toISOString()
    };
    const previous: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) previous[k] = (row as Record<string, unknown>)[k];
    const { error: bErr } = await supabase.from(BACKUP_TABLE).insert({ seller_id: sellerId, economics_id: t.id, previous_values: previous, new_values: patch });
    if (bErr) throw new Error(bErr.message);
    const { error: uErr } = await supabase.from("amazon_product_economics").update(patch).eq("id", t.id);
    if (uErr) throw new Error(uErr.message);
    applied.push(t.sku ?? t.asin ?? t.id);
  }
  return { applied };
}

/** Restores every product changed by the switch (that has not been reverted yet). */
export async function undoReturnRateSwitch(sellerId: string) {
  const { data, error } = await supabase.from(BACKUP_TABLE).select("*").eq("seller_id", sellerId).is("reverted_at", null).order("applied_at", { ascending: false });
  if (error) throw new Error(error.message);
  for (const b of data ?? []) {
    const { error: uErr } = await supabase.from("amazon_product_economics").update(b.previous_values).eq("id", b.economics_id);
    if (uErr) throw new Error(uErr.message);
    await supabase.from(BACKUP_TABLE).update({ reverted_at: new Date().toISOString() }).eq("id", b.id);
  }
  return { reverted: (data ?? []).length };
}
