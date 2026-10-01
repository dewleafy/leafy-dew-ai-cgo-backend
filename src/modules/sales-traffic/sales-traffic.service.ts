import { supabase } from "../../db/supabase";

export type SalesTrafficRow = {
  asin: string;
  sku: string | null;
  sessions: number;
  pageViews: number;
  unitsOrdered: number;
  orderedSales: number;
  conversionPct: number | null;
  avgBuyBoxPct: number | null;
  prevSessions: number;
  prevUnitsOrdered: number;
  sessionsChangePct: number | null;
  unitsChangePct: number | null;
  flags: string[];
};

export type SalesTrafficSummary = {
  days: number;
  hasData: boolean;
  lastSnapshotDate: string | null;
  totals: { sessions: number; pageViews: number; unitsOrdered: number; orderedSales: number; conversionPct: number | null };
  products: SalesTrafficRow[];
};

type RawRow = {
  snapshot_date: string;
  child_asin: string;
  sku: string | null;
  sessions: number | null;
  page_views: number | null;
  buy_box_percentage: number | null;
  units_ordered: number | null;
  ordered_sales: number | null;
};

const MIN_SESSIONS_FOR_FLAGS = 30;
const LOW_CONVERSION_PCT = 3;
const DROP_PCT = -30;
const LOW_BUY_BOX_PCT = 80;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const change = (now: number, prev: number): number | null => (prev > 0 ? Math.round(((now - prev) / prev) * 1000) / 10 : null);

export async function getSalesTrafficSummary(sellerId: string, daysInput = 14): Promise<SalesTrafficSummary> {
  const days = Math.min(Math.max(Math.floor(daysInput) || 14, 1), 60);
  const since = new Date(Date.now() - days * 2 * 86400000).toISOString().slice(0, 10);
  const splitDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("amazon_sp_sales_traffic")
    .select("snapshot_date, child_asin, sku, sessions, page_views, buy_box_percentage, units_ordered, ordered_sales")
    .eq("seller_id", sellerId)
    .gte("snapshot_date", since)
    .limit(20000);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as RawRow[];
  const byAsin = new Map<string, { cur: RawRow[]; prev: RawRow[]; sku: string | null }>();
  let lastDate: string | null = null;
  for (const r of rows) {
    if (!r.child_asin) continue;
    if (!lastDate || r.snapshot_date > lastDate) lastDate = r.snapshot_date;
    const entry = byAsin.get(r.child_asin) ?? { cur: [], prev: [], sku: r.sku };
    (r.snapshot_date >= splitDate ? entry.cur : entry.prev).push(r);
    if (r.sku) entry.sku = r.sku;
    byAsin.set(r.child_asin, entry);
  }

  const products: SalesTrafficRow[] = [];
  for (const [asin, e] of byAsin) {
    const sum = (list: RawRow[], k: "sessions" | "page_views" | "units_ordered" | "ordered_sales") => list.reduce((a, r) => a + num(r[k]), 0);
    const sessions = sum(e.cur, "sessions");
    const units = sum(e.cur, "units_ordered");
    const prevSessions = sum(e.prev, "sessions");
    const prevUnits = sum(e.prev, "units_ordered");
    const bb = e.cur.filter((r) => r.buy_box_percentage !== null);
    const avgBuyBox = bb.length ? Math.round((bb.reduce((a, r) => a + num(r.buy_box_percentage), 0) / bb.length) * 10) / 10 : null;
    const conversion = pct(units, sessions);
    const sessionsChange = change(sessions, prevSessions);
    const unitsChange = change(units, prevUnits);

    const flags: string[] = [];
    if (sessions >= MIN_SESSIONS_FOR_FLAGS && conversion !== null && conversion < LOW_CONVERSION_PCT) flags.push("LOW_CONVERSION");
    if (prevUnits >= 3 && unitsChange !== null && unitsChange <= DROP_PCT) flags.push("SALES_DROP");
    if (prevSessions >= MIN_SESSIONS_FOR_FLAGS && sessionsChange !== null && sessionsChange <= DROP_PCT) flags.push("TRAFFIC_DROP");
    if (sessions >= MIN_SESSIONS_FOR_FLAGS && avgBuyBox !== null && avgBuyBox < LOW_BUY_BOX_PCT) flags.push("LOW_BUY_BOX");

    products.push({
      asin, sku: e.sku, sessions, pageViews: sum(e.cur, "page_views"), unitsOrdered: units,
      orderedSales: Math.round(sum(e.cur, "ordered_sales") * 100) / 100, conversionPct: conversion, avgBuyBoxPct: avgBuyBox,
      prevSessions, prevUnitsOrdered: prevUnits, sessionsChangePct: sessionsChange, unitsChangePct: unitsChange, flags
    });
  }
  products.sort((a, b) => b.sessions - a.sessions);

  const tSessions = products.reduce((a, p) => a + p.sessions, 0);
  const tUnits = products.reduce((a, p) => a + p.unitsOrdered, 0);
  return {
    days,
    hasData: rows.length > 0,
    lastSnapshotDate: lastDate,
    totals: {
      sessions: tSessions,
      pageViews: products.reduce((a, p) => a + p.pageViews, 0),
      unitsOrdered: tUnits,
      orderedSales: Math.round(products.reduce((a, p) => a + p.orderedSales, 0) * 100) / 100,
      conversionPct: pct(tUnits, tSessions)
    },
    products
  };
}
