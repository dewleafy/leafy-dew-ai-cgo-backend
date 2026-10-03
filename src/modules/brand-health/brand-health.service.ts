import { supabase } from "../../db/supabase";
import { getAplusContentCoverage } from "../aplus-content/aplus-content.service";
import { getAmazonSpSalesSummary } from "../amazon-sp/amazon-sp.service";
import { resolveBrandName } from "../brand-readiness/brand-readiness.service";
import { BrandHealth, computeBrandHealth, TRUST_DEFECT_PATTERN } from "./brand-health.rules";

export type BrandHealthRow = BrandHealth & { brandName: string; unitsSold: number; returnedUnits: number; aplusProducts: number };

export async function getBrandHealth(sellerId: string, days = 30): Promise<{ days: number; brands: BrandHealthRow[] }> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [sales, returns, aplus] = await Promise.all([
    getAmazonSpSalesSummary(sellerId, days),
    supabase.from("amazon_sp_returns").select("sku, product_name, quantity, reason").eq("seller_id", sellerId).gte("return_date", since).limit(5000),
    getAplusContentCoverage(sellerId).catch(() => null)
  ]);
  if (returns.error) throw new Error(returns.error.message);

  const acc = new Map<string, { units: number; returned: number; defect: number }>();
  const get = (b: string) => acc.get(b) ?? { units: 0, returned: 0, defect: 0 };
  for (const s of (sales.bySku ?? []) as Array<{ sku: string | null; title: string | null; confirmedUnits: number }>) {
    const b = resolveBrandName({ sku: s.sku, product_name: s.title });
    const a = get(b); a.units += Number(s.confirmedUnits ?? 0); acc.set(b, a);
  }
  for (const r of returns.data ?? []) {
    const b = resolveBrandName({ sku: r.sku as string | null, product_name: r.product_name as string | null });
    const q = Number(r.quantity ?? 1) || 1;
    const a = get(b); a.returned += q;
    if (TRUST_DEFECT_PATTERN.test(String(r.reason ?? ""))) a.defect += q;
    acc.set(b, a);
  }
  const brandNames = new Set<string>([...acc.keys(), ...(aplus?.brands ?? []).map((x) => x.brandName)]);
  const brands: BrandHealthRow[] = [...brandNames].map((brandName) => {
    const a = get(brandName);
    const ap = aplus?.brands.find((x) => x.brandName === brandName);
    const health = computeBrandHealth({
      unitsSold: a.units, returnedUnits: a.returned, trustDefectUnits: a.defect,
      aplusProducts: ap?.productCount ?? 0, aplusWithContent: ap?.hasContentCount ?? 0, aplusNotChecked: ap?.notCheckedCount ?? 0
    });
    return { brandName, unitsSold: a.units, returnedUnits: a.returned, aplusProducts: ap?.productCount ?? 0, ...health };
  });
  return { days, brands };
}
