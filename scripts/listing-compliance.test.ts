import { checkListingCompliance, hasComplianceBlocker } from "../src/modules/listing-compliance/listing-compliance.rules";
let failed = 0;
function t(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
const codes = (x: ReturnType<typeof checkListingCompliance>) => x.map((f) => f.code);
t("clean title passes", checkListingCompliance({ draftType: "TITLE", text: "Leafy Dew Ceramic Planter Pot 6 inch with Drainage Hole" }).length === 0);
t("medical claim blocks", hasComplianceBlocker(checkListingCompliance({ draftType: "DESCRIPTION", text: "This pot cures plant disease" })));
t("price wording blocks", codes(checkListingCompliance({ draftType: "TITLE", text: "Planter 50% off today" })).includes("PRICE_OR_PROMO"));
t("invented BIS blocks", codes(checkListingCompliance({ draftType: "BULLETS", text: "BIS certified material" })).includes("UNVERIFIED_CERTIFICATION"));
t("known BIS allowed", !codes(checkListingCompliance({ draftType: "BULLETS", text: "BIS certified material", knownFacts: "Made of BIS certified material" })).includes("UNVERIFIED_CERTIFICATION"));
t("long title blocks", codes(checkListingCompliance({ draftType: "TITLE", text: "a ".repeat(120) })).includes("TITLE_TOO_LONG"));
t("empty text ok", checkListingCompliance({ draftType: "TITLE", text: "" }).length === 0);
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
