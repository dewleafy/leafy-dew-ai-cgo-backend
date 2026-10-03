import assert from "node:assert";
import { computeBrandHealth, TRUST_DEFECT_PATTERN } from "../src/modules/brand-health/brand-health.rules";
const low = computeBrandHealth({ unitsSold: 5, returnedUnits: 1, trustDefectUnits: 1, aplusProducts: 3, aplusWithContent: 0, aplusNotChecked: 3 });
assert.equal(low.trustLabel, "NOT_ENOUGH_DATA"); assert.equal(low.aplusCoveragePct, null);
const good = computeBrandHealth({ unitsSold: 200, returnedUnits: 10, trustDefectUnits: 4, aplusProducts: 4, aplusWithContent: 2, aplusNotChecked: 0 });
assert.equal(good.trustDefectRatePct, 2); assert.equal(good.trustLabel, "GOOD"); assert.equal(good.aplusCoveragePct, 50);
assert.equal(computeBrandHealth({ unitsSold: 100, returnedUnits: 12, trustDefectUnits: 9, aplusProducts: 0, aplusWithContent: 0, aplusNotChecked: 0 }).trustLabel, "POOR");
assert(TRUST_DEFECT_PATTERN.test("CR-DEFECTIVE")); assert(!TRUST_DEFECT_PATTERN.test("CR-UNWANTED_ITEM"));
console.log("brand-health tests passed");
