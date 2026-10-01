// Weekly strategy verdict per product. Pure function: combines profit room (Product Economics)
// with traffic health (Sales & Traffic). Advice only; it never changes anything on Amazon.

export type StrategyVerdict = "PUSH" | "HOLD" | "ORGANIC_ONLY" | "LOSING_MONEY" | "FIX_LISTING" | "INVESTIGATE" | "FIX_COSTS";

export type StrategyInput = {
  profitStatus: string | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  flags: string[];
  sessions: number;
};

export type StrategyResult = { verdict: StrategyVerdict; headline: string; action: string };

const PUSH_MIN_TARGET_ACOS = 15;

export function decideStrategy(i: StrategyInput): StrategyResult {
  const targetAcos = i.targetAcos;
  const breakEven = i.breakEvenAcos;
  if (targetAcos === null || breakEven === null || i.profitStatus === "NEEDS_COST_DATA") {
    return { verdict: "FIX_COSTS", headline: "Costs are incomplete", action: "Fill in product cost, packaging and weight so profit can be calculated." };
  }
  if (breakEven < 0) {
    return { verdict: "LOSING_MONEY", headline: "Loses money on every sale, even with no ads", action: "Raise the price, cut the cost, or stop selling this product." };
  }
  if (targetAcos < 0) {
    return { verdict: "ORGANIC_ONLY", headline: "No room for ads at the target profit", action: "Keep ads off. Improve price or cost first, then reconsider." };
  }
  if (i.flags.includes("LOW_CONVERSION")) {
    return { verdict: "FIX_LISTING", headline: "Visitors are not buying", action: "Review price, images, title and reviews before spending more on ads." };
  }
  if (i.flags.includes("SALES_DROP") || i.flags.includes("TRAFFIC_DROP") || i.flags.includes("LOW_BUY_BOX")) {
    return { verdict: "INVESTIGATE", headline: "Sales or visits fell, or the Buy Box is lost", action: "Check stock, price, competitors and ad status for this product." };
  }
  if (targetAcos >= PUSH_MIN_TARGET_ACOS) {
    return { verdict: "PUSH", headline: "Healthy profit room for ads", action: `Safe to grow with ads up to about ${Math.round(targetAcos)}% ACOS.` };
  }
  return { verdict: "HOLD", headline: "Small ad room", action: `Keep ads tightly capped, about ${Math.round(targetAcos)}% ACOS at most.` };
}
