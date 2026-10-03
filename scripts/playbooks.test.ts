import assert from "node:assert";
import { evaluatePlaybooks } from "../src/modules/playbooks/playbooks.rules";
const base = { impressions: 0, clicks: 0, adCost: 0, adSales: 0, adOrders: 0, breakEvenAcos: 30, sessions: 0, conversionPct: null, returns30d: 0, topReturnReason: null };
assert.equal(evaluatePlaybooks(base).length, 0);
assert(evaluatePlaybooks({ ...base, impressions: 5000, clicks: 5 }).some((h) => h.key === "LOW_CTR"));
assert(!evaluatePlaybooks({ ...base, impressions: 500, clicks: 0 }).some((h) => h.key === "LOW_CTR"));
assert(evaluatePlaybooks({ ...base, adCost: 300, adOrders: 0 }).some((h) => h.key === "HIGH_ACOS"));
assert(evaluatePlaybooks({ ...base, adCost: 300, adSales: 600, adOrders: 2 }).some((h) => h.key === "HIGH_ACOS")); // 50% > 30%
assert(!evaluatePlaybooks({ ...base, adCost: 100, adSales: 1000, adOrders: 5 }).some((h) => h.key === "HIGH_ACOS"));
assert(evaluatePlaybooks({ ...base, sessions: 100, conversionPct: 1.5 }).some((h) => h.key === "LOW_CONVERSION"));
assert(evaluatePlaybooks({ ...base, returns30d: 4, topReturnReason: "NOT_AS_DESCRIBED" }).some((h) => h.key === "RETURN_REDUCTION"));
console.log("playbooks tests passed");
