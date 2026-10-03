// Harvard + IIM strategic layer (blueprint section 3). Pure functions, advice only.
// Uses only data the app really has. Anything it cannot measure is reported as "not measured",
// never guessed.
import type { StrategyVerdict } from "./strategy.rules";

export type Positioning = "DIFFERENTIATE" | "COST_EFFICIENCY" | "UNDECIDED";

export type StrategicInput = {
  verdict: StrategyVerdict;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  flags: string[];
  sessions: number;
};

export type StrategicAssessment = {
  score: number | null; // Strategic Action Score; null when profit data is missing
  positioning: Positioning;
  positioningNote: string;
  doNot: string[]; // Harvard "trade-off discipline": what we should NOT do
  notMeasured: string[];
};

// Blueprint 3.3: (Profit + Brand + Satisfaction + Moat + Learning) / (Effort + Risk + Cost + Uncertainty + Dilution)
// Only profit, learning, effort, risk, uncertainty can be derived from real data. Others are listed as not measured.
export function assessStrategicAction(i: StrategicInput): StrategicAssessment {
  const notMeasured = ["Brand equity gain", "Customer satisfaction gain", "Moat strength", "Brand dilution risk"];
  const room = i.targetAcos;
  let positioning: Positioning = "UNDECIDED";
  let positioningNote = "Profit data is incomplete, so the winning approach cannot be chosen yet.";
  if (room !== null && i.breakEvenAcos !== null) {
    if (i.breakEvenAcos >= 40) {
      positioning = "DIFFERENTIATE";
      positioningNote = "Wide margin: win with story, gifting and design quality rather than price.";
    } else if (i.breakEvenAcos >= 0) {
      positioning = "COST_EFFICIENCY";
      positioningNote = "Thin margin: win by lowering cost, returns and ad waste before spending on brand extras.";
    } else {
      positioningNote = "Loses money per sale: fix price or cost before any positioning work.";
    }
  }

  const doNot: string[] = [];
  if (i.verdict === "LOSING_MONEY") doNot.push("Do not run ads or discounts on this product.");
  if (i.verdict === "ORGANIC_ONLY") doNot.push("Do not start paid ads until price or cost improves.");
  if (i.verdict === "FIX_LISTING") doNot.push("Do not raise ad budget while visitors are not buying.");
  if (i.verdict === "INVESTIGATE") doNot.push("Do not cut price or bids before checking stock, Buy Box and competitors.");
  if (i.verdict === "FIX_COSTS") doNot.push("Do not make price or ad decisions until costs are filled in.");
  if (positioning === "DIFFERENTIATE") doNot.push("Do not compete on price cuts; it weakens the premium position.");
  if (i.sessions > 0 && i.sessions < 30) doNot.push("Do not judge this product yet; there are too few visits.");

  if (room === null || i.breakEvenAcos === null) return { score: null, positioning, positioningNote, doNot, notMeasured };

  const profit = Math.max(0, Math.min(10, room / 4)); // 40% target ACOS room = 10
  const learning = i.sessions < 30 ? 6 : 3; // low-traffic products teach us more per action
  const effort = i.verdict === "PUSH" || i.verdict === "HOLD" ? 2 : i.verdict === "FIX_LISTING" ? 5 : 4;
  const risk = i.flags.includes("SALES_DROP") || i.flags.includes("LOW_BUY_BOX") ? 6 : i.verdict === "LOSING_MONEY" ? 7 : 3;
  const uncertainty = i.sessions < 30 ? 7 : 2;
  const score = Math.round(((profit + learning) / Math.max(1, effort + risk + uncertainty)) * 100) / 100;
  return { score, positioning, positioningNote, doNot, notMeasured };
}

// IIM contextual strategy: Indian festival calendar (approximate dates; confirm each year).
const FESTIVALS: Array<{ name: string; month: number; day: number; prepDays: number }> = [
  { name: "Navratri", month: 10, day: 11, prepDays: 30 },
  { name: "Dussehra", month: 10, day: 20, prepDays: 30 },
  { name: "Diwali", month: 11, day: 8, prepDays: 45 },
  { name: "Christmas / New Year", month: 12, day: 25, prepDays: 30 },
  { name: "Republic Day sales", month: 1, day: 26, prepDays: 21 },
  { name: "Holi", month: 3, day: 4, prepDays: 30 },
  { name: "Raksha Bandhan", month: 8, day: 28, prepDays: 30 },
  { name: "Ganesh Chaturthi", month: 9, day: 14, prepDays: 30 }
];

export type FestivalWindow = { name: string; daysAway: number; inPrepWindow: boolean; advice: string };

export function upcomingFestivals(now: Date, limit = 3): FestivalWindow[] {
  const out: FestivalWindow[] = [];
  for (const f of FESTIVALS) {
    let d = new Date(Date.UTC(now.getUTCFullYear(), f.month - 1, f.day));
    if (d.getTime() < now.getTime() - 24 * 3600 * 1000) d = new Date(Date.UTC(now.getUTCFullYear() + 1, f.month - 1, f.day));
    const daysAway = Math.ceil((d.getTime() - now.getTime()) / (24 * 3600 * 1000));
    const inPrepWindow = daysAway <= f.prepDays;
    out.push({
      name: f.name,
      daysAway,
      inPrepWindow,
      advice: inPrepWindow
        ? `${f.name} is ${daysAway} days away: check stock cover, gifting content and ad budget now.`
        : `${f.name} is ${daysAway} days away: plan stock and content about ${f.prepDays} days before.`
    });
  }
  return out.sort((a, b) => a.daysAway - b.daysAway).slice(0, limit);
}
