// Blueprint section 17: playbooks. Pure rules; advice only. Mature 7-day windows (blueprint section 12).
export type PlaybookKey = "LOW_CTR" | "HIGH_ACOS" | "LOW_CONVERSION" | "RETURN_REDUCTION";

export type PlaybookInput = {
  impressions: number;
  clicks: number;
  adCost: number;
  adSales: number;
  adOrders: number;
  breakEvenAcos: number | null;
  sessions: number;
  conversionPct: number | null;
  returns30d: number;
  topReturnReason: string | null;
};

export type PlaybookHit = { key: PlaybookKey; title: string; trigger: string; actions: string[]; approvalTier: "TIER_2" | "TIER_3" };

export const LOW_CTR_PCT = 0.25;
export const MIN_IMPRESSIONS = 1000;
export const MIN_SPEND_FOR_ACOS = 200;
export const MIN_SESSIONS = 30;
export const LOW_CONVERSION_PCT = 3;
export const MIN_RETURNS = 3;

export function evaluatePlaybooks(i: PlaybookInput): PlaybookHit[] {
  const hits: PlaybookHit[] = [];
  const ctr = i.impressions > 0 ? (i.clicks / i.impressions) * 100 : null;
  if (ctr !== null && i.impressions >= MIN_IMPRESSIONS && ctr < LOW_CTR_PCT) {
    hits.push({
      key: "LOW_CTR",
      title: "Low click rate",
      trigger: `${i.impressions} ad views but only ${ctr.toFixed(2)}% clicked (7 days).`,
      actions: ["Review the main image against competitors.", "Make the first words of the title clearer.", "Check the price and any offer badge."],
      approvalTier: "TIER_3"
    });
  }
  const acos = i.adSales > 0 ? (i.adCost / i.adSales) * 100 : null;
  if (i.adCost >= MIN_SPEND_FOR_ACOS && (i.adOrders === 0 || (acos !== null && i.breakEvenAcos !== null && acos > i.breakEvenAcos))) {
    hits.push({
      key: "HIGH_ACOS",
      title: "Ads cost more than the profit",
      trigger: i.adOrders === 0 ? `Spent ${Math.round(i.adCost)} on ads with no orders (7 days).` : `Ad cost is ${acos!.toFixed(0)}% of ad sales; the product breaks even at ${i.breakEvenAcos}% (7 days).`,
      actions: ["Lower bids on the weakest keywords.", "Add negative keywords for terms that cost without selling.", "Move budget to better products."],
      approvalTier: "TIER_2"
    });
  }
  if (i.sessions >= MIN_SESSIONS && i.conversionPct !== null && i.conversionPct < LOW_CONVERSION_PCT) {
    hits.push({
      key: "LOW_CONVERSION",
      title: "Visitors are not buying",
      trigger: `${i.sessions} visits but only ${i.conversionPct}% bought.`,
      actions: ["Improve the image order and add a size or dimension image.", "Answer the common objections in the bullets or A+ content.", "Check reviews and Q&A for repeated doubts."],
      approvalTier: "TIER_3"
    });
  }
  if (i.returns30d >= MIN_RETURNS) {
    hits.push({
      key: "RETURN_REDUCTION",
      title: "Too many returns",
      trigger: `${i.returns30d} returns in 30 days${i.topReturnReason ? `, most often: ${i.topReturnReason}` : ""}.`,
      actions: ["Check that photos, colour and size match the real product.", "Clarify dimensions in the listing.", "Check packaging and quality with the supplier."],
      approvalTier: "TIER_3"
    });
  }
  return hits;
}
