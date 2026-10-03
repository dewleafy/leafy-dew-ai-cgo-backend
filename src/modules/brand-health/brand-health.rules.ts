// Blueprint section 9.2 brand KPIs, only those the app can really measure today.
export const TRUST_DEFECT_PATTERN = /DEFECT|QUALITY|NOT_AS_DESCRIBED|WRONG|SIZE|COLOR|COLOUR|DAMAGED|MISSING|MISMATCH|APPEAR/i;

export type BrandHealthInput = {
  unitsSold: number;
  returnedUnits: number;
  trustDefectUnits: number;
  aplusProducts: number;
  aplusWithContent: number;
  aplusNotChecked: number;
};

export type BrandHealth = {
  returnRatePct: number | null;
  trustDefectRatePct: number | null;
  aplusCoveragePct: number | null;
  trustLabel: "GOOD" | "WATCH" | "POOR" | "NOT_ENOUGH_DATA";
  notMeasured: string[];
};

const MIN_UNITS = 20;

export function computeBrandHealth(i: BrandHealthInput): BrandHealth {
  const enough = i.unitsSold >= MIN_UNITS;
  const returnRatePct = enough ? round((i.returnedUnits / i.unitsSold) * 100) : null;
  const trustDefectRatePct = enough ? round((i.trustDefectUnits / i.unitsSold) * 100) : null;
  const checked = i.aplusProducts - i.aplusNotChecked;
  const aplusCoveragePct = checked > 0 ? round((i.aplusWithContent / checked) * 100) : null;
  let trustLabel: BrandHealth["trustLabel"] = "NOT_ENOUGH_DATA";
  if (trustDefectRatePct !== null) trustLabel = trustDefectRatePct <= 3 ? "GOOD" : trustDefectRatePct <= 6 ? "WATCH" : "POOR";
  return {
    returnRatePct,
    trustDefectRatePct,
    aplusCoveragePct,
    trustLabel,
    notMeasured: ["Brand search growth", "Store conversion rate", "Repeat purchase rate", "Basket affinity", "Premium price tolerance", "Brand consistency score"]
  };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
