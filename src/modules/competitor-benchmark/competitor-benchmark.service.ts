import { supabase } from "../../db/supabase";
import { amazonSpGet } from "../amazon-sp/amazon-sp-client.service";
import { requireConnectedConnection } from "../amazon-sp/amazon-sp.service";
import { getAmazonSpAccessToken } from "../amazon-sp/amazon-sp-token.service";
import { AmazonSpConnectionRow } from "../amazon-sp/amazon-sp.types";
import { cleanText, logSafeAmazonSpError, safeErrorDetails, safeErrorMessage, toIntegerOrNull, toNumberOrNull } from "../amazon-sp/amazon-sp-utils";
import { listProductPassports } from "../product-passports/product-passports.service";
import { SafeProductPassportRow } from "../product-passports/product-passports.types";
import {
  CompetitorBenchmarkCandidateRow,
  CompetitorBenchmarkCandidateSource,
  CompetitorBenchmarkDataRow,
  CompetitorBenchmarkDimension,
  CompetitorBenchmarkFindingRow,
  CompetitorBenchmarkImageBriefRow,
  CompetitorBenchmarkImageMockupRow,
  CompetitorBenchmarkRunRow,
  SafeCompetitorBenchmarkCandidate,
  SafeCompetitorBenchmarkData,
  SafeCompetitorBenchmarkFinding,
  SafeCompetitorBenchmarkRun,
  SafeCompetitorBenchmarkSkuGroup
} from "./competitor-benchmark.types";

export const MAX_OWN_SKUS = 20;
const MAX_DISCOVERY_SUGGESTIONS_PER_SKU = 8;
const PRICING_BATCH_SIZE = 20;
const CATALOG_INCLUDED_DATA = ["summaries", "images", "attributes", "salesRanks"];

export class CompetitorBenchmarkError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CompetitorBenchmarkError";
    this.status = status;
  }
}

function logError(context: string, error: unknown): void {
  const details = safeErrorDetails(error);
  if (typeof details === "string") {
    logSafeAmazonSpError(context, { message: details });
  } else {
    logSafeAmazonSpError(context, { message: safeErrorMessage(error), details: JSON.stringify(details) });
  }
}

async function getAmazonConnectionOrNull(sellerId: string): Promise<{ connection: AmazonSpConnectionRow; accessToken: string } | null> {
  try {
    const connection = await requireConnectedConnection(sellerId);
    const accessToken = await getAmazonSpAccessToken(connection.id);
    return { connection, accessToken };
  } catch {
    return null;
  }
}

function keywordsFromProductName(productName: string | null | undefined): string | null {
  const text = cleanText(productName ?? null);
  if (!text) return null;
  // Amazon's keyword search works best on the distinctive leading words, not the full title
  // (which often trails off into size/color/pack-count variants that narrow the match too much).
  const words = text.replace(/[|,/]/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(0, 7).join(" ") || null;
}

function isLikelyAsin(value: string): boolean {
  return /^[A-Z0-9]{10}$/.test(value);
}

function normalizeAsin(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return isLikelyAsin(trimmed) ? trimmed : null;
}

// ---- Catalog payload extraction (precise, not the heuristic flatten used by product-media) ----

function marketplaceEntries(payload: Record<string, unknown>, key: string, marketplaceId: string): Record<string, unknown>[] {
  const list = payload[key];
  if (!Array.isArray(list)) return [];
  const entries = list.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  const matching = entries.filter((entry) => entry.marketplaceId === marketplaceId);
  return matching.length > 0 ? matching : entries;
}

function countCatalogImages(payload: Record<string, unknown>, marketplaceId: string): number | null {
  const entries = marketplaceEntries(payload, "images", marketplaceId);
  if (entries.length === 0) return null;
  const images = entries[0]?.images;
  return Array.isArray(images) ? images.length : null;
}

function readAttribute(payload: Record<string, unknown>, attributeName: string): unknown[] | null {
  const attributes = payload.attributes;
  if (!attributes || typeof attributes !== "object") return null;
  const value = (attributes as Record<string, unknown>)[attributeName];
  return Array.isArray(value) ? value : null;
}

function readSummary(payload: Record<string, unknown>, marketplaceId: string): Record<string, unknown> | null {
  const entries = marketplaceEntries(payload, "summaries", marketplaceId);
  return entries[0] ?? null;
}

function extractBulletCount(payload: Record<string, unknown>): number | null {
  const bullets = readAttribute(payload, "bullet_point");
  return bullets ? bullets.length : null;
}

function extractTitleLength(payload: Record<string, unknown>, marketplaceId: string): number | null {
  const itemNameAttr = readAttribute(payload, "item_name");
  const attrValue = itemNameAttr && itemNameAttr[0] && typeof itemNameAttr[0] === "object"
    ? (itemNameAttr[0] as Record<string, unknown>).value
    : null;
  if (typeof attrValue === "string" && attrValue.trim()) return attrValue.trim().length;

  const summary = readSummary(payload, marketplaceId);
  const itemName = summary?.itemName;
  return typeof itemName === "string" && itemName.trim() ? itemName.trim().length : null;
}

function extractTitle(payload: Record<string, unknown>, marketplaceId: string): string | null {
  const summary = readSummary(payload, marketplaceId);
  const itemName = summary?.itemName;
  return typeof itemName === "string" && itemName.trim() ? itemName.trim() : null;
}

function extractSalesRank(payload: Record<string, unknown>, marketplaceId: string): { rank: number | null; title: string | null } {
  const entries = marketplaceEntries(payload, "salesRanks", marketplaceId);
  const entry = entries[0];
  if (!entry) return { rank: null, title: null };

  const classificationRanks = Array.isArray(entry.classificationRanks) ? entry.classificationRanks : [];
  const displayGroupRanks = Array.isArray(entry.displayGroupRanks) ? entry.displayGroupRanks : [];
  const best = (classificationRanks[0] ?? displayGroupRanks[0]) as Record<string, unknown> | undefined;
  if (!best) return { rank: null, title: null };

  return {
    rank: toIntegerOrNull(best.rank),
    title: typeof best.title === "string" ? best.title : null
  };
}

// ---- Own SKU resolution ----

type CandidateInsertRow = {
  run_id: string;
  seller_id: string;
  own_sku: string;
  own_asin: string | null;
  asin: string;
  title: string | null;
  source: CompetitorBenchmarkCandidateSource;
  confirmed: boolean | null;
  added_manually: boolean;
};

type ResolvedOwnSku = { sku: string; passport: SafeProductPassportRow };

async function resolveOwnSkus(sellerId: string, skus: string[]): Promise<{ resolved: ResolvedOwnSku[]; skipped: { sku: string; reason: string }[] }> {
  const passports = await listProductPassports({ sellerId });
  const bySku = new Map<string, SafeProductPassportRow>();
  for (const passport of passports) {
    if (passport.sku) bySku.set(passport.sku, passport);
  }

  const resolved: ResolvedOwnSku[] = [];
  const skipped: { sku: string; reason: string }[] = [];

  for (const rawSku of skus) {
    const sku = cleanText(rawSku);
    if (!sku) continue;
    const passport = bySku.get(sku);
    if (!passport) {
      skipped.push({ sku, reason: "No product passport found with this SKU. Add it under Product Passport first." });
      continue;
    }
    if (!passport.asin) {
      skipped.push({ sku, reason: "This product passport has no ASIN recorded, so it can't be matched against Amazon's catalog." });
      continue;
    }
    resolved.push({ sku, passport });
  }

  return { resolved, skipped };
}

// ---- Run creation + discovery ----

export async function createCompetitorBenchmarkRun(input: { sellerId: string; skus: string[] }): Promise<{
  run: SafeCompetitorBenchmarkRun;
  skippedSkus: { sku: string; reason: string }[];
}> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const dedupedSkus = Array.from(new Set(input.skus.map((sku) => cleanText(sku)).filter((sku): sku is string => Boolean(sku))));

  if (dedupedSkus.length === 0) {
    throw new CompetitorBenchmarkError("At least one SKU is required.");
  }
  if (dedupedSkus.length > MAX_OWN_SKUS) {
    throw new CompetitorBenchmarkError(`A maximum of ${MAX_OWN_SKUS} SKUs is allowed per run.`);
  }

  const { resolved, skipped } = await resolveOwnSkus(sellerId, dedupedSkus);

  const { data: runData, error: runError } = await supabase
    .from("competitor_benchmark_runs")
    .insert({ seller_id: sellerId, own_skus: resolved.map((r) => r.sku), status: "DISCOVERING" })
    .select("*")
    .single<CompetitorBenchmarkRunRow>();

  if (runError || !runData) {
    logError("Could not create competitor benchmark run.", runError);
    throw new Error("Could not create the competitor benchmark run in Supabase.");
  }

  if (resolved.length === 0) {
    const { data: failedRun } = await supabase
      .from("competitor_benchmark_runs")
      .update({ status: "FAILED", error_message: "None of the requested SKUs could be resolved.", updated_at: new Date().toISOString() })
      .eq("id", runData.id)
      .select("*")
      .single<CompetitorBenchmarkRunRow>();
    return { run: await assembleRun(failedRun ?? runData, sellerId), skippedSkus: skipped };
  }

  const amazon = await getAmazonConnectionOrNull(sellerId);
  const discoveryErrors: string[] = [];

  // Own-baseline candidate rows first -- every real SP-API pull for these own ASINs runs
  // through the exact same compare-step code path as a competitor, so "own" and "competitor"
  // numbers are never mixed from two different sources.
  const ownBaselineRows: CandidateInsertRow[] = resolved.map((r) => ({
    run_id: runData.id,
    seller_id: sellerId,
    own_sku: r.sku,
    own_asin: r.passport.asin,
    asin: r.passport.asin as string,
    title: r.passport.productName,
    source: "OWN_BASELINE" as CompetitorBenchmarkCandidateSource,
    confirmed: true,
    added_manually: false
  }));

  const existingPassportCandidateRows: CandidateInsertRow[] = [];
  for (const r of resolved) {
    const existingAsins = Array.isArray(r.passport.competitorAsins)
      ? r.passport.competitorAsins.filter((asin): asin is string => typeof asin === "string" && isLikelyAsin(asin.trim().toUpperCase()))
      : [];
    for (const asinRaw of existingAsins) {
      const asin = asinRaw.trim().toUpperCase();
      if (asin === r.passport.asin) continue;
      existingPassportCandidateRows.push({
        run_id: runData.id,
        seller_id: sellerId,
        own_sku: r.sku,
        own_asin: r.passport.asin,
        asin,
        title: null,
        source: "EXISTING_PASSPORT",
        confirmed: null,
        added_manually: false
      });
    }
  }

  const insertRows = [...ownBaselineRows, ...existingPassportCandidateRows];
  if (insertRows.length > 0) {
    const { error: insertError } = await supabase
      .from("competitor_benchmark_candidates")
      .upsert(insertRows, { onConflict: "run_id,own_sku,asin", ignoreDuplicates: true });
    if (insertError) {
      logError("Could not save own-baseline/existing-passport candidates.", insertError);
    }
  }

  // Discovery via Amazon's official Catalog Items search (searchCatalogItems) -- keyword-based,
  // same marketplace, no scraping of any Amazon page. Per-SKU failure never fails the whole run.
  if (amazon) {
    for (const r of resolved) {
      const keywords = keywordsFromProductName(r.passport.productName);
      if (!keywords) {
        discoveryErrors.push(`${r.sku}: no usable product name to search with.`);
        continue;
      }

      try {
        const searchResult = await amazonSpGet<Record<string, unknown>>({
          path: "/catalog/2022-04-01/items",
          accessToken: amazon.accessToken,
          region: amazon.connection.region,
          stage: "SEARCH_CATALOG_ITEMS_COMPETITOR_DISCOVERY",
          query: {
            marketplaceIds: [amazon.connection.marketplace_id],
            keywords: [keywords],
            includedData: ["summaries"],
            pageSize: MAX_DISCOVERY_SUGGESTIONS_PER_SKU + 2
          }
        });

        const items = Array.isArray(searchResult.items) ? searchResult.items : [];
        const candidateRows: CandidateInsertRow[] = [];

        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const asin = normalizeAsin(String((item as Record<string, unknown>).asin ?? ""));
          if (!asin || asin === r.passport.asin) continue;
          if (candidateRows.length >= MAX_DISCOVERY_SUGGESTIONS_PER_SKU) break;

          const title = extractTitle(item as Record<string, unknown>, amazon.connection.marketplace_id);
          candidateRows.push({
            run_id: runData.id,
            seller_id: sellerId,
            own_sku: r.sku,
            own_asin: r.passport.asin,
            asin,
            title,
            source: "CATALOG_SEARCH",
            confirmed: null,
            added_manually: false
          });
        }

        if (candidateRows.length > 0) {
          const { error: insertCandidatesError } = await supabase
            .from("competitor_benchmark_candidates")
            .upsert(candidateRows, { onConflict: "run_id,own_sku,asin", ignoreDuplicates: true });
          if (insertCandidatesError) {
            logError("Could not save discovered candidates.", insertCandidatesError);
          }
        } else {
          discoveryErrors.push(`${r.sku}: Amazon's catalog search returned no comparable ASINs for "${keywords}".`);
        }
      } catch (error) {
        discoveryErrors.push(`${r.sku}: ${safeErrorMessage(error)}`);
      }
    }
  } else {
    discoveryErrors.push("Amazon isn't connected for this seller, so no automatic competitor suggestions could run. You can still add competitor ASINs manually before comparing.");
  }

  const { data: updatedRun } = await supabase
    .from("competitor_benchmark_runs")
    .update({
      status: "AWAITING_CONFIRMATION",
      error_message: discoveryErrors.length > 0 ? discoveryErrors.join("; ") : null,
      updated_at: new Date().toISOString()
    })
    .eq("id", runData.id)
    .select("*")
    .single<CompetitorBenchmarkRunRow>();

  return { run: await assembleRun(updatedRun ?? runData, sellerId), skippedSkus: skipped };
}

// ---- Loading / assembling a run for the frontend ----

async function loadRunRow(id: string, sellerId: string): Promise<CompetitorBenchmarkRunRow | null> {
  const { data, error } = await supabase
    .from("competitor_benchmark_runs")
    .select("*")
    .eq("id", id)
    .eq("seller_id", sellerId)
    .maybeSingle<CompetitorBenchmarkRunRow>();

  if (error) {
    logError("Could not load competitor benchmark run.", error);
    throw new Error("Could not load the competitor benchmark run from Supabase.");
  }

  return data ?? null;
}

function toSafeData(row: CompetitorBenchmarkDataRow | undefined | null): SafeCompetitorBenchmarkData | null {
  if (!row) return null;
  return {
    asin: row.asin,
    price: toNumberOrNull(row.price),
    currency: row.currency,
    rating: toNumberOrNull(row.rating),
    reviewCount: row.review_count,
    imageCount: row.image_count,
    bulletCount: row.bullet_count,
    titleLength: row.title_length,
    categorySalesRank: row.category_sales_rank,
    categorySalesRankTitle: row.category_sales_rank_title,
    fetchStatus: row.fetch_status,
    fetchError: row.fetch_error,
    fetchedAt: row.fetched_at
  };
}

async function assembleRun(run: CompetitorBenchmarkRunRow, sellerId: string): Promise<SafeCompetitorBenchmarkRun> {
  const [candidatesResult, dataResult, findingsResult, briefsResult, mockupsResult] = await Promise.all([
    supabase.from("competitor_benchmark_candidates").select("*").eq("run_id", run.id).order("created_at", { ascending: true }),
    supabase.from("competitor_benchmark_data").select("*").eq("run_id", run.id),
    supabase.from("competitor_benchmark_findings").select("*").eq("run_id", run.id).order("created_at", { ascending: true }),
    supabase.from("competitor_benchmark_image_briefs").select("*").eq("run_id", run.id),
    supabase.from("competitor_benchmark_image_mockups").select("*").eq("run_id", run.id).order("requested_at", { ascending: true })
  ]);

  const candidates = (candidatesResult.data ?? []) as CompetitorBenchmarkCandidateRow[];
  const dataRows = (dataResult.data ?? []) as CompetitorBenchmarkDataRow[];
  const findings = (findingsResult.data ?? []) as CompetitorBenchmarkFindingRow[];
  const briefs = (briefsResult.data ?? []) as CompetitorBenchmarkImageBriefRow[];
  const mockups = (mockupsResult.data ?? []) as CompetitorBenchmarkImageMockupRow[];

  const dataByCandidateId = new Map(dataRows.map((row) => [row.candidate_id, row]));

  const skuOrder = run.own_skus.length > 0
    ? run.own_skus
    : Array.from(new Set(candidates.map((c) => c.own_sku)));

  const skus: SafeCompetitorBenchmarkSkuGroup[] = skuOrder.map((ownSku) => {
    const skuCandidates = candidates.filter((c) => c.own_sku === ownSku);
    const ownCandidate = skuCandidates.find((c) => c.source === "OWN_BASELINE");
    const brief = briefs.find((b) => b.own_sku === ownSku) ?? null;

    return {
      ownSku,
      ownAsin: ownCandidate?.own_asin ?? null,
      candidates: skuCandidates.map((c): SafeCompetitorBenchmarkCandidate => ({
        id: c.id,
        ownSku: c.own_sku,
        ownAsin: c.own_asin,
        asin: c.asin,
        title: c.title,
        source: c.source,
        confirmed: c.confirmed,
        addedManually: c.added_manually,
        discoveryError: c.discovery_error,
        data: toSafeData(dataByCandidateId.get(c.id))
      })),
      findings: findings
        .filter((f) => f.own_sku === ownSku)
        .map((f): SafeCompetitorBenchmarkFinding => ({
          dimension: f.dimension,
          ownValue: toNumberOrNull(f.own_value),
          bestCompetitorValue: toNumberOrNull(f.best_competitor_value),
          bestCompetitorAsin: f.best_competitor_asin,
          gapSummary: f.gap_summary
        })),
      imageBrief: brief
        ? { ownSku: brief.own_sku, recommendedChanges: brief.recommended_changes, basedOnAsins: brief.based_on_asins, updatedAt: brief.updated_at }
        : null,
      imageMockups: mockups
        .filter((m) => m.own_sku === ownSku)
        .map((m) => ({
          imageSlot: m.image_slot,
          status: m.status,
          mockupUrl: m.mockup_url,
          note: m.note,
          requestedAt: m.requested_at
        }))
    };
  });

  return {
    id: run.id,
    sellerId: run.seller_id,
    ownSkus: run.own_skus,
    status: run.status,
    errorMessage: run.error_message,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    skus
  };
}

export async function getCompetitorBenchmarkRun(input: { id: string; sellerId: string }): Promise<SafeCompetitorBenchmarkRun | null> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const run = await loadRunRow(input.id, sellerId);
  if (!run) return null;
  return assembleRun(run, sellerId);
}

export async function listCompetitorBenchmarkRuns(input: { sellerId: string; limit?: number }): Promise<SafeCompetitorBenchmarkRun[]> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const { data, error } = await supabase
    .from("competitor_benchmark_runs")
    .select("*")
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    logError("Could not list competitor benchmark runs.", error);
    throw new Error("Could not load competitor benchmark runs from Supabase.");
  }

  const rows = (data ?? []) as CompetitorBenchmarkRunRow[];
  return Promise.all(rows.map((row) => assembleRun(row, sellerId)));
}

// ---- Candidate confirmation ----

export async function confirmCompetitorBenchmarkCandidates(input: {
  runId: string;
  sellerId: string;
  ownSku: string;
  confirmedAsins: string[];
  removedAsins: string[];
  addedAsins: string[];
}): Promise<SafeCompetitorBenchmarkRun> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const run = await loadRunRow(input.runId, sellerId);
  if (!run) {
    throw new CompetitorBenchmarkError("Competitor benchmark run not found.", 404);
  }

  const ownSku = cleanText(input.ownSku);
  if (!ownSku) {
    throw new CompetitorBenchmarkError("ownSku is required.");
  }

  const confirmedAsins = input.confirmedAsins.map((a) => normalizeAsin(a)).filter((a): a is string => Boolean(a));
  const removedAsins = input.removedAsins.map((a) => normalizeAsin(a)).filter((a): a is string => Boolean(a));
  const addedAsins = input.addedAsins.map((a) => normalizeAsin(a)).filter((a): a is string => Boolean(a));

  if (confirmedAsins.length > 0) {
    const { error } = await supabase
      .from("competitor_benchmark_candidates")
      .update({ confirmed: true, updated_at: new Date().toISOString() })
      .eq("run_id", run.id)
      .eq("own_sku", ownSku)
      .in("asin", confirmedAsins);
    if (error) logError("Could not confirm competitor benchmark candidates.", error);
  }

  if (removedAsins.length > 0) {
    const { error } = await supabase
      .from("competitor_benchmark_candidates")
      .update({ confirmed: false, updated_at: new Date().toISOString() })
      .eq("run_id", run.id)
      .eq("own_sku", ownSku)
      .in("asin", removedAsins);
    if (error) logError("Could not remove competitor benchmark candidates.", error);
  }

  if (addedAsins.length > 0) {
    const rows = addedAsins.map((asin) => ({
      run_id: run.id,
      seller_id: sellerId,
      own_sku: ownSku,
      own_asin: null,
      asin,
      title: null,
      source: "MANUAL" as CompetitorBenchmarkCandidateSource,
      confirmed: true,
      added_manually: true
    }));
    const { error } = await supabase
      .from("competitor_benchmark_candidates")
      .upsert(rows, { onConflict: "run_id,own_sku,asin" });
    if (error) logError("Could not add manual competitor benchmark candidates.", error);
  }

  if (run.status === "DISCOVERING") {
    await supabase
      .from("competitor_benchmark_runs")
      .update({ status: "AWAITING_CONFIRMATION", updated_at: new Date().toISOString() })
      .eq("id", run.id);
  }

  const refreshed = await loadRunRow(run.id, sellerId);
  return assembleRun(refreshed ?? run, sellerId);
}

// ---- Comparison (Stage: pull real data, compute findings, write Stage-1 image brief) ----

function pickExtreme(
  entries: { asin: string; value: number }[],
  direction: "min" | "max"
): { asin: string; value: number } | null {
  if (entries.length === 0) return null;
  return entries.reduce((best, entry) => {
    if (!best) return entry;
    if (direction === "min") return entry.value < best.value ? entry : best;
    return entry.value > best.value ? entry : best;
  }, null as { asin: string; value: number } | null);
}

function buildFindingSentence(input: {
  dimension: CompetitorBenchmarkDimension;
  ownValue: number | null;
  best: { asin: string; value: number } | null;
}): string {
  const { dimension, ownValue, best } = input;
  if (ownValue === null || !best) {
    return "Not enough real data was available from Amazon to compare this dimension.";
  }

  switch (dimension) {
    case "PRICE":
      return ownValue <= best.value
        ? `Your price (₹${ownValue}) is at or below the lowest confirmed competitor price (₹${best.value}, ${best.asin}).`
        : `Your price (₹${ownValue}) is above the lowest confirmed competitor price (₹${best.value}, ${best.asin}).`;
    case "IMAGE_COUNT":
      return ownValue >= best.value
        ? `You have ${ownValue} listing images, matching or beating the strongest confirmed competitor (${best.value}, ${best.asin}).`
        : `You have ${ownValue} listing images; the strongest confirmed competitor (${best.asin}) has ${best.value}.`;
    case "BULLET_COUNT":
      return ownValue >= best.value
        ? `You have ${ownValue} bullet points, matching or beating the strongest confirmed competitor (${best.value}, ${best.asin}).`
        : `You have ${ownValue} bullet points; the strongest confirmed competitor (${best.asin}) has ${best.value}.`;
    case "TITLE_LENGTH":
      return `Your title is ${ownValue} characters; the strongest confirmed competitor's (${best.asin}) is ${best.value} characters. Longer isn't automatically better -- check whether theirs includes search terms yours doesn't.`;
    case "CATEGORY_SALES_RANK":
      return ownValue <= best.value
        ? `Your category sales rank (${ownValue}) is at or ahead of the best confirmed competitor's (${best.value}, ${best.asin}). Lower is better.`
        : `Your category sales rank (${ownValue}) is behind the best confirmed competitor's (${best.value}, ${best.asin}). Lower is better.`;
    default:
      return "Comparison not available for this dimension.";
  }
}

export async function runCompetitorBenchmarkComparison(input: { runId: string; sellerId: string }): Promise<SafeCompetitorBenchmarkRun> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const run = await loadRunRow(input.runId, sellerId);
  if (!run) {
    throw new CompetitorBenchmarkError("Competitor benchmark run not found.", 404);
  }

  await supabase.from("competitor_benchmark_runs").update({ status: "COMPARING", updated_at: new Date().toISOString() }).eq("id", run.id);

  const amazon = await getAmazonConnectionOrNull(sellerId);
  if (!amazon) {
    await supabase
      .from("competitor_benchmark_runs")
      .update({
        status: "FAILED",
        error_message: "Amazon isn't connected for this seller, so no real catalog or pricing data could be pulled for comparison.",
        updated_at: new Date().toISOString()
      })
      .eq("id", run.id);
    return (await getCompetitorBenchmarkRun({ id: run.id, sellerId })) as SafeCompetitorBenchmarkRun;
  }

  const { data: candidateRows, error: candidatesError } = await supabase
    .from("competitor_benchmark_candidates")
    .select("*")
    .eq("run_id", run.id)
    .eq("confirmed", true);

  if (candidatesError) {
    logError("Could not load confirmed candidates for comparison.", candidatesError);
    throw new Error("Could not load confirmed candidates from Supabase.");
  }

  const candidates = (candidateRows ?? []) as CompetitorBenchmarkCandidateRow[];

  // Pricing is pulled in batches of up to 20 distinct ASINs per call (the Pricing API's own
  // limit), separately from the per-ASIN catalog pull below (there's no batch catalog endpoint).
  const distinctAsins = Array.from(new Set(candidates.map((c) => c.asin)));
  const priceByAsin = new Map<string, { price: number | null; currency: string | null; raw: Record<string, unknown> }>();

  for (let i = 0; i < distinctAsins.length; i += PRICING_BATCH_SIZE) {
    const chunk = distinctAsins.slice(i, i + PRICING_BATCH_SIZE);
    try {
      const pricingResult = await amazonSpGet<Record<string, unknown>>({
        path: "/products/pricing/v0/competitivePrice",
        accessToken: amazon.accessToken,
        region: amazon.connection.region,
        stage: "GET_COMPETITIVE_PRICING_FOR_BENCHMARK",
        query: {
          MarketplaceId: amazon.connection.marketplace_id,
          Asins: chunk,
          ItemType: "Asin"
        }
      });

      const payload = Array.isArray(pricingResult.payload) ? pricingResult.payload : [];
      for (const entry of payload) {
        if (!entry || typeof entry !== "object") continue;
        const asin = typeof (entry as Record<string, unknown>).ASIN === "string" ? (entry as Record<string, unknown>).ASIN as string : null;
        if (!asin) continue;
        const competitivePrices = (entry as Record<string, unknown>).Product && typeof (entry as Record<string, unknown>).Product === "object"
          ? ((entry as Record<string, unknown>).Product as Record<string, unknown>).CompetitivePricing
          : null;
        const priceList = competitivePrices && typeof competitivePrices === "object"
          ? (competitivePrices as Record<string, unknown>).CompetitivePrices
          : null;
        const firstPrice = Array.isArray(priceList) ? priceList[0] : null;
        const landedPrice = firstPrice && typeof firstPrice === "object"
          ? (firstPrice as Record<string, unknown>).Price && typeof (firstPrice as Record<string, unknown>).Price === "object"
            ? ((firstPrice as Record<string, unknown>).Price as Record<string, unknown>).LandedPrice
            : null
          : null;
        const amount = landedPrice && typeof landedPrice === "object" ? toNumberOrNull((landedPrice as Record<string, unknown>).Amount) : null;
        const currency = landedPrice && typeof landedPrice === "object" && typeof (landedPrice as Record<string, unknown>).CurrencyCode === "string"
          ? (landedPrice as Record<string, unknown>).CurrencyCode as string
          : null;
        priceByAsin.set(asin, { price: amount, currency, raw: entry as Record<string, unknown> });
      }
    } catch (error) {
      logError("Could not fetch competitive pricing for benchmark.", error);
      // Pricing is supplementary (not every ASIN has a competitive offer on Amazon); a failed
      // batch just leaves those ASINs with price = null rather than failing the whole compare.
    }
  }

  for (const candidate of candidates) {
    let fetchStatus: "FETCHED" | "FAILED" = "FETCHED";
    let fetchError: string | null = null;
    let catalogPayload: Record<string, unknown> | null = null;
    let imageCount: number | null = null;
    let bulletCount: number | null = null;
    let titleLength: number | null = null;
    let salesRank: { rank: number | null; title: string | null } = { rank: null, title: null };

    try {
      catalogPayload = await amazonSpGet<Record<string, unknown>>({
        path: `/catalog/2022-04-01/items/${encodeURIComponent(candidate.asin)}`,
        accessToken: amazon.accessToken,
        region: amazon.connection.region,
        stage: "GET_CATALOG_ITEM_COMPETITOR_BENCHMARK",
        query: {
          marketplaceIds: [amazon.connection.marketplace_id],
          includedData: CATALOG_INCLUDED_DATA
        }
      });

      imageCount = countCatalogImages(catalogPayload, amazon.connection.marketplace_id);
      bulletCount = extractBulletCount(catalogPayload);
      titleLength = extractTitleLength(catalogPayload, amazon.connection.marketplace_id);
      salesRank = extractSalesRank(catalogPayload, amazon.connection.marketplace_id);
    } catch (error) {
      fetchStatus = "FAILED";
      fetchError = safeErrorMessage(error);
      logError(`Could not fetch catalog item for benchmark candidate ${candidate.asin}.`, error);
    }

    const pricing = priceByAsin.get(candidate.asin) ?? null;
    const now = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from("competitor_benchmark_data")
      .upsert({
        candidate_id: candidate.id,
        run_id: run.id,
        asin: candidate.asin,
        price: pricing?.price ?? null,
        currency: pricing?.currency ?? null,
        rating: null,
        review_count: null,
        image_count: imageCount,
        bullet_count: bulletCount,
        title_length: titleLength,
        category_sales_rank: salesRank.rank,
        category_sales_rank_title: salesRank.title,
        raw_catalog_payload: catalogPayload,
        raw_pricing_payload: pricing?.raw ?? null,
        fetch_status: fetchStatus,
        fetch_error: fetchError,
        fetched_at: now,
        updated_at: now
      }, { onConflict: "candidate_id" });

    if (upsertError) {
      logError(`Could not save benchmark data for candidate ${candidate.asin}.`, upsertError);
    }

    // Catalog search results don't carry a title until compare runs -- fill it in now if the
    // candidate still has none (e.g. a manually-added or existing-passport ASIN).
    if (!candidate.title && catalogPayload) {
      const title = extractTitle(catalogPayload, amazon.connection.marketplace_id);
      if (title) {
        await supabase.from("competitor_benchmark_candidates").update({ title, updated_at: now }).eq("id", candidate.id);
      }
    }
  }

  // ---- Findings + Stage-1 image brief, per own SKU ----

  const ownSkus = Array.from(new Set(candidates.map((c) => c.own_sku)));
  const { data: freshDataRows } = await supabase.from("competitor_benchmark_data").select("*").eq("run_id", run.id);
  const dataByCandidateId = new Map(((freshDataRows ?? []) as CompetitorBenchmarkDataRow[]).map((row) => [row.candidate_id, row]));

  for (const ownSku of ownSkus) {
    const skuCandidates = candidates.filter((c) => c.own_sku === ownSku);
    const ownCandidate = skuCandidates.find((c) => c.source === "OWN_BASELINE");
    const competitorCandidates = skuCandidates.filter((c) => c.source !== "OWN_BASELINE");

    const ownData = ownCandidate ? dataByCandidateId.get(ownCandidate.id) : null;
    const competitorData = competitorCandidates
      .map((c) => ({ asin: c.asin, row: dataByCandidateId.get(c.id) }))
      .filter((entry) => entry.row && entry.row.fetch_status === "FETCHED");

    await supabase.from("competitor_benchmark_findings").delete().eq("run_id", run.id).eq("own_sku", ownSku);

    const dimensionPlans: { dimension: CompetitorBenchmarkDimension; field: keyof CompetitorBenchmarkDataRow; direction: "min" | "max" }[] = [
      { dimension: "PRICE", field: "price", direction: "min" },
      { dimension: "IMAGE_COUNT", field: "image_count", direction: "max" },
      { dimension: "BULLET_COUNT", field: "bullet_count", direction: "max" },
      { dimension: "TITLE_LENGTH", field: "title_length", direction: "max" },
      { dimension: "CATEGORY_SALES_RANK", field: "category_sales_rank", direction: "min" }
    ];

    const findingsToInsert: Record<string, unknown>[] = [];
    const imageGapChanges: string[] = [];
    const basedOnAsins = new Set<string>();

    for (const plan of dimensionPlans) {
      const ownValue = ownData ? toNumberOrNull(ownData[plan.field] as number | string | null) : null;
      const entries = competitorData
        .map((entry) => ({ asin: entry.asin, value: toNumberOrNull(entry.row![plan.field] as number | string | null) }))
        .filter((entry): entry is { asin: string; value: number } => entry.value !== null);
      const best = pickExtreme(entries, plan.direction);

      if (ownValue === null || !best) continue;

      findingsToInsert.push({
        run_id: run.id,
        own_sku: ownSku,
        dimension: plan.dimension,
        own_value: ownValue,
        best_competitor_value: best.value,
        best_competitor_asin: best.asin,
        gap_summary: buildFindingSentence({ dimension: plan.dimension, ownValue, best })
      });

      const gapFavorsCompetitor = plan.direction === "max" ? best.value > ownValue : best.value < ownValue;
      if (gapFavorsCompetitor && (plan.dimension === "IMAGE_COUNT" || plan.dimension === "BULLET_COUNT" || plan.dimension === "TITLE_LENGTH")) {
        basedOnAsins.add(best.asin);
        if (plan.dimension === "IMAGE_COUNT") {
          imageGapChanges.push(`Add ${best.value - ownValue} more listing image(s) -- the strongest confirmed competitor (${best.asin}) has ${best.value}, you have ${ownValue}.`);
        } else if (plan.dimension === "BULLET_COUNT") {
          imageGapChanges.push(`Add ${best.value - ownValue} more bullet point(s) -- the strongest confirmed competitor (${best.asin}) has ${best.value}, you have ${ownValue}.`);
        } else if (plan.dimension === "TITLE_LENGTH") {
          imageGapChanges.push(`Your title (${ownValue} characters) is noticeably shorter than ${best.asin}'s (${best.value} characters) -- check whether theirs includes search terms yours is missing.`);
        }
      }
    }

    if (findingsToInsert.length > 0) {
      const { error } = await supabase.from("competitor_benchmark_findings").insert(findingsToInsert);
      if (error) logError("Could not save competitor benchmark findings.", error);
    }

    const recommendedChanges = imageGapChanges.length > 0
      ? imageGapChanges
      : ["No clear image or listing-completeness gap was found versus your confirmed competitors on this pass."];

    const { error: briefError } = await supabase
      .from("competitor_benchmark_image_briefs")
      .upsert({
        run_id: run.id,
        own_sku: ownSku,
        recommended_changes: recommendedChanges,
        based_on_asins: Array.from(basedOnAsins),
        updated_at: new Date().toISOString()
      }, { onConflict: "run_id,own_sku" });

    if (briefError) logError("Could not save competitor benchmark image brief.", briefError);
  }

  await supabase
    .from("competitor_benchmark_runs")
    .update({ status: "DONE", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", run.id);

  return (await getCompetitorBenchmarkRun({ id: run.id, sellerId })) as SafeCompetitorBenchmarkRun;
}

// ---- Stage 2: image mockup request (not yet configured -- see spec's open items) ----

export async function requestCompetitorBenchmarkImageMockup(input: {
  runId: string;
  sellerId: string;
  ownSku: string;
  imageSlot: number;
}): Promise<{ ok: boolean; configured: boolean; message: string }> {
  const sellerId = cleanText(input.sellerId) ?? "default";
  const run = await loadRunRow(input.runId, sellerId);
  if (!run) {
    throw new CompetitorBenchmarkError("Competitor benchmark run not found.", 404);
  }

  const ownSku = cleanText(input.ownSku);
  if (!ownSku) {
    throw new CompetitorBenchmarkError("ownSku is required.");
  }

  const message = "Stage 2 (AI-generated image mockups) needs an image-generation service to be chosen and connected first -- this hasn't been set up yet, so no mockup was generated. Stage 1's written image checklist above is ready to use now.";
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("competitor_benchmark_image_mockups")
    .upsert({
      run_id: run.id,
      own_sku: ownSku,
      image_slot: input.imageSlot,
      status: "NOT_CONFIGURED",
      mockup_url: null,
      note: message,
      requested_at: now,
      updated_at: now
    }, { onConflict: "run_id,own_sku,image_slot" });

  if (error) {
    logError("Could not record competitor benchmark image mockup request.", error);
  }

  return { ok: true, configured: false, message };
}
