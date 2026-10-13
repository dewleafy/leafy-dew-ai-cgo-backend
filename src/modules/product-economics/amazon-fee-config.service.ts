import { supabase } from "../../db/supabase";
import { logger } from "../../utils/logger";

// Amazon fee configuration: referral fee rules, closing fee bands, and the misc scalar fee
// settings used by calculateProductEconomics() (product-economics.service.ts). These used to be
// hardcoded TypeScript constants, which meant correcting a wrong Amazon rate required a code
// change, a GitHub paste, and a redeploy every time. As of 2026-10-13 the real values live in
// three Supabase tables (amazon_fee_referral_rules, amazon_fee_closing_bands,
// amazon_fee_settings) that a recurring check (a scheduled task, roughly every 15 days) can
// write to directly -- so a rate correction reaches the live app within hours, without a deploy.
//
// calculateProductEconomics() stays a pure, synchronous function (it's called in hot paths --
// e.g. once per competitor per SKU in the Competitor Benchmark Tool), so this module does NOT
// make it async. Instead it keeps an in-memory cache, refreshed from Supabase on a timer
// (startAmazonFeeConfigScheduler, called once from server.ts), and calculateProductEconomics
// reads the cache through the getters below.
//
// The hardcoded DEFAULT_* values below are the exact, 2026-10-13-verified figures (see
// product-economics.service.ts's own history for how each was confirmed) and are what the app
// uses if the Supabase tables are ever empty, unreachable, or structurally broken -- a database
// hiccup must never be able to silently zero out or corrupt the live profit calculator. A
// refresh is only ever applied if it looks at least as complete as these defaults; otherwise the
// previous (last-good, or default) cache is kept and the failure is logged.

export type ReferralFeeTier = { maxPrice: number; percent: number };
export type ClosingFeeTier = { maxPrice: number; fee: number };
export type ReferralFeeConfidence = "CONFIRMED" | "UNVERIFIED_LEGACY";

type ReferralCategoryConfig = { tiers: ReferralFeeTier[]; confidence: ReferralFeeConfidence };

const INF = Number.POSITIVE_INFINITY;

// Verified 2026-10-13 against https://sell.amazon.in/fees-and-pricing (fetched twice
// independently, matching both times). All 23 categories confirmed.
const DEFAULT_REFERRAL_FEE_RULES: Record<string, ReferralFeeTier[]> = {
  "home decor products": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 17 }],
  "home - other products": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 18 }],
  "home improvement - other products": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 13.5 }],
  "home improvement - accessories": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 13.5 }],
  "home storage": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 15 }],
  "home furnishing": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 11 }],
  "home - fragrance & candles": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 12.5 }],
  "kitchen - glassware & ceramicware": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 12.5 }],
  "cookware, tableware & dinnerware": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 12.5 }],
  "rugs and doormats": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 9 }],
  "clocks": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 10 }],
  "wall art": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 13.5 }],
  "bedsheets, blankets and covers": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 8.5 }],
  "containers, boxes, bottles": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 12 }],
  "curtains and accessories": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 16.5 }],
  "cushion covers": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 10 }],
  "indoor lighting": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 12.5 }],
  "indoor lighting - others": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 16 }],
  "led bulbs and battens": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 14 }],
  "wall paints and tools": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 6 }],
  "craft materials": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 5 }],
  "safes and lockers": [{ maxPrice: 1000, percent: 0 }, { maxPrice: INF, percent: 12 }],
  "mattresses": [
    { maxPrice: 500, percent: 25.5 },
    { maxPrice: 1000, percent: 0 },
    { maxPrice: 20000, percent: 16 },
    { maxPrice: INF, percent: 13.5 }
  ]
};
const DEFAULT_REFERRAL_CONFIDENCE: Record<string, ReferralFeeConfidence> = Object.fromEntries(
  Object.keys(DEFAULT_REFERRAL_FEE_RULES).map((category) => [category, "CONFIRMED" as const])
);

const DEFAULT_CLOSING_FEE_BANDS: Record<string, ClosingFeeTier[]> = {
  fc: [
    { maxPrice: 300, fee: 27 },
    { maxPrice: 500, fee: 23 },
    { maxPrice: 1000, fee: 25 },
    { maxPrice: INF, fee: 75 }
  ],
  easy_ship: [
    { maxPrice: 300, fee: 2 },
    { maxPrice: 500, fee: 23 },
    { maxPrice: 1000, fee: 36 },
    { maxPrice: INF, fee: 67 }
  ],
  easy_ship_prime: [
    { maxPrice: 300, fee: 2 },
    { maxPrice: 500, fee: 23 },
    { maxPrice: 1000, fee: 36 },
    { maxPrice: INF, fee: 67 }
  ],
  self_ship: [
    { maxPrice: 300, fee: 20 },
    { maxPrice: 500, fee: 26 },
    { maxPrice: 1000, fee: 50 },
    { maxPrice: INF, fee: 100 }
  ],
  seller_flex: [
    { maxPrice: 300, fee: 7 },
    { maxPrice: 500, fee: 13 },
    { maxPrice: 1000, fee: 36 },
    { maxPrice: INF, fee: 67 }
  ]
};

const DEFAULT_FEE_SETTINGS: Record<string, number> = {
  refund_commission_threshold_price: 300,
  refund_commission_low: 59,
  refund_commission_high: 88.5,
  shipping_fee_tier1_max_kg: 0.5,
  shipping_fee_tier1_fee: 50,
  shipping_fee_tier2_max_kg: 1,
  shipping_fee_tier2_fee: 70,
  shipping_fee_tier3_fee: 100,
  pick_and_pack_standard_fee: 17,
  pick_and_pack_oversize_fee: 25,
  storage_fee_per_cuft: 5,
  hidden_other_fee: 10,
  default_return_rate_percent: 25,
  default_return_penalty_fraction_percent: 66.7,
  default_repackaging_cost: 10,
  default_tcs_percent: 0.5,
  default_product_gst_percent: 18,
  default_amazon_fee_gst_percent: 18
};

let referralFeeRulesCache: Record<string, ReferralFeeTier[]> = DEFAULT_REFERRAL_FEE_RULES;
let referralConfidenceCache: Record<string, ReferralFeeConfidence> = DEFAULT_REFERRAL_CONFIDENCE;
let closingFeeBandsCache: Record<string, ClosingFeeTier[]> = DEFAULT_CLOSING_FEE_BANDS;
let feeSettingsCache: Record<string, number> = DEFAULT_FEE_SETTINGS;
let lastLoadedAt: string | null = null;
let lastLoadSource: "DEFAULT" | "SUPABASE" = "DEFAULT";
let lastLoadError: string | null = null;

export function getReferralFeeRules(): Record<string, ReferralFeeTier[]> {
  return referralFeeRulesCache;
}

export function getReferralFeeConfidence(category: string): ReferralFeeConfidence {
  return referralConfidenceCache[category] ?? "UNVERIFIED_LEGACY";
}

export function getClosingFeeBands(): Record<string, ClosingFeeTier[]> {
  return closingFeeBandsCache;
}

export function getFeeSetting(key: string): number {
  const value = feeSettingsCache[key];
  return value !== undefined ? value : (DEFAULT_FEE_SETTINGS[key] ?? 0);
}

export function getAmazonFeeConfigStatus(): {
  lastLoadedAt: string | null;
  lastLoadSource: "DEFAULT" | "SUPABASE";
  lastLoadError: string | null;
  referralCategoryCount: number;
  closingChannelCount: number;
  settingsCount: number;
} {
  return {
    lastLoadedAt,
    lastLoadSource,
    lastLoadError,
    referralCategoryCount: Object.keys(referralFeeRulesCache).length,
    closingChannelCount: Object.keys(closingFeeBandsCache).length,
    settingsCount: Object.keys(feeSettingsCache).length
  };
}

type ReferralRuleRow = { category: string; tier_order: number; max_price: number | string | null; percent: number | string; confidence: string | null };
type ClosingBandRow = { channel: string; tier_order: number; max_price: number | string | null; fee: number | string };
type SettingRow = { key: string; value: number | string };

function toNum(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeReferralConfidence(dbValue: string | null): ReferralFeeConfidence {
  return dbValue === "CONFIRMED" || dbValue === "CONFIRMED_FROM_SETTLEMENT_DATA" ? "CONFIRMED" : "UNVERIFIED_LEGACY";
}

// Reloads the in-memory fee config cache from Supabase. Safe to call anytime (startup, on a
// timer, or on demand) -- never throws, and never replaces a good cache with a broken or
// incomplete one. Every failure is logged and the previous (last-good or default) cache stays
// in effect, so a Supabase outage or a half-finished data edit degrades to "using slightly stale
// or default rates," never to "the profit calculator breaks."
export async function loadAmazonFeeConfigFromDb(): Promise<void> {
  try {
    const [referralResult, closingResult, settingsResult] = await Promise.all([
      supabase.from("amazon_fee_referral_rules").select("category, tier_order, max_price, percent, confidence").order("tier_order", { ascending: true }),
      supabase.from("amazon_fee_closing_bands").select("channel, tier_order, max_price, fee").order("tier_order", { ascending: true }),
      supabase.from("amazon_fee_settings").select("key, value")
    ]);

    if (referralResult.error) throw new Error(`amazon_fee_referral_rules read failed: ${referralResult.error.message}`);
    if (closingResult.error) throw new Error(`amazon_fee_closing_bands read failed: ${closingResult.error.message}`);
    if (settingsResult.error) throw new Error(`amazon_fee_settings read failed: ${settingsResult.error.message}`);

    const referralRows = (referralResult.data ?? []) as ReferralRuleRow[];
    const closingRows = (closingResult.data ?? []) as ClosingBandRow[];
    const settingsRows = (settingsResult.data ?? []) as SettingRow[];

    const nextReferral: Record<string, ReferralFeeTier[]> = {};
    const nextReferralConfidence: Record<string, ReferralFeeConfidence> = {};
    for (const row of referralRows) {
      const maxPrice = toNum(row.max_price);
      const percent = toNum(row.percent);
      if (percent === null) continue; // skip a malformed row rather than let it corrupt the table
      const tiers = nextReferral[row.category] ?? (nextReferral[row.category] = []);
      tiers.push({ maxPrice: maxPrice === null ? INF : maxPrice, percent });
      // Every tier for a category was seeded with the same confidence; the first row wins if
      // that ever drifts, rather than flip-flopping per tier.
      if (nextReferralConfidence[row.category] === undefined) {
        nextReferralConfidence[row.category] = normalizeReferralConfidence(row.confidence);
      }
    }

    const nextClosing: Record<string, ClosingFeeTier[]> = {};
    for (const row of closingRows) {
      const maxPrice = toNum(row.max_price);
      const fee = toNum(row.fee);
      if (fee === null) continue;
      const tiers = nextClosing[row.channel] ?? (nextClosing[row.channel] = []);
      tiers.push({ maxPrice: maxPrice === null ? INF : maxPrice, fee });
    }

    const nextSettings: Record<string, number> = { ...DEFAULT_FEE_SETTINGS };
    for (const row of settingsRows) {
      const value = toNum(row.value);
      if (value === null) continue;
      nextSettings[row.key] = value;
    }

    // Refuse a structurally incomplete refresh (fewer categories/channels than the hardcoded
    // defaults ship with, or any category/channel with zero tiers) rather than trust raw row
    // counts alone -- a half-applied migration or a bad manual edit must not reach the live
    // calculator.
    const referralCategoryCount = Object.keys(nextReferral).length;
    const closingChannelCount = Object.keys(nextClosing).length;
    const defaultReferralCount = Object.keys(DEFAULT_REFERRAL_FEE_RULES).length;
    const defaultClosingCount = Object.keys(DEFAULT_CLOSING_FEE_BANDS).length;

    if (referralCategoryCount < defaultReferralCount) {
      throw new Error(`amazon_fee_referral_rules has ${referralCategoryCount} categories, fewer than the ${defaultReferralCount} the app expects -- not applying this refresh.`);
    }
    if (closingChannelCount < defaultClosingCount) {
      throw new Error(`amazon_fee_closing_bands has ${closingChannelCount} channels, fewer than the ${defaultClosingCount} the app expects -- not applying this refresh.`);
    }
    for (const [category, tiers] of Object.entries(nextReferral)) {
      if (tiers.length === 0) throw new Error(`Referral category "${category}" has zero tiers -- not applying this refresh.`);
    }
    for (const [channel, tiers] of Object.entries(nextClosing)) {
      if (tiers.length === 0) throw new Error(`Closing channel "${channel}" has zero tiers -- not applying this refresh.`);
    }

    referralFeeRulesCache = nextReferral;
    referralConfidenceCache = nextReferralConfidence;
    closingFeeBandsCache = nextClosing;
    feeSettingsCache = nextSettings;
    lastLoadedAt = new Date().toISOString();
    lastLoadSource = "SUPABASE";
    lastLoadError = null;
    logger.info(
      `Amazon fee config reloaded from Supabase: ${referralCategoryCount} referral categories, ${closingChannelCount} closing channels, ${Object.keys(nextSettings).length} settings.`
    );
  } catch (error) {
    lastLoadError = error instanceof Error ? error.message : String(error);
    logger.warn(`Amazon fee config reload from Supabase failed, keeping previous values: ${lastLoadError}`);
  }
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours -- frequent enough that a direct
// Supabase write (from the scheduled 15-day check, or a manual correction) reaches the live app
// the same day, without needing every running server instance to restart.
const STARTUP_DELAY_MS = 20 * 1000;

export function startAmazonFeeConfigScheduler(): void {
  logger.info(`Amazon fee config scheduler starting — refreshes from Supabase every ${REFRESH_INTERVAL_MS / 3600000} hours.`);
  setTimeout(() => {
    void loadAmazonFeeConfigFromDb();
    setInterval(() => {
      void loadAmazonFeeConfigFromDb();
    }, REFRESH_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
