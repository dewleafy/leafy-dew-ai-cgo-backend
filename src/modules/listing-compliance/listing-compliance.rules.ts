// Compliance checker for proposed Amazon listing text (title, bullets, description, etc.).
// Pure function: no database or AI calls. Findings are advisory flags shown on the approval card.

export type ComplianceSeverity = "BLOCKER" | "WARNING";

export type ComplianceFinding = {
  code: string;
  severity: ComplianceSeverity;
  message: string;
  match?: string;
};

export type ComplianceInput = {
  draftType: string;
  text: string | null | undefined;
  /** Text already published or stated by the seller; claims found here are not flagged as invented. */
  knownFacts?: string | null;
};

const TITLE_MAX = 200;
const BULLET_MAX = 500;

type Rule = { code: string; severity: ComplianceSeverity; message: string; pattern: RegExp; skipIfKnown?: boolean };

const RULES: Rule[] = [
  { code: "MEDICAL_CLAIM", severity: "BLOCKER", message: "Medical or health-cure claims are not allowed on Amazon listings.", pattern: /\b(cures?|treats?|heals?|prevents? (?:disease|cancer|diabetes|infection)|anti[- ]?bacterial|anti[- ]?viral|clinically proven|doctor recommended|therapeutic)\b/i },
  { code: "UNVERIFIED_CERTIFICATION", severity: "BLOCKER", message: "Certification or safety claim not found in the seller's own known facts. Verify before approving.", pattern: /\b(BIS|ISI|CE marked|CE certified|FDA approved|FSSAI|ISO ?\d{3,5}|ASTM|food[- ]?grade|BPA[- ]?free|non[- ]?toxic|organic certified|lab tested|dermatologically tested)\b/i, skipIfKnown: true },
  { code: "PRICE_OR_PROMO", severity: "BLOCKER", message: "Price, discount, free-shipping or promotion wording is not allowed in listing text.", pattern: /(₹|\brs\.?\s?\d|\bINR\b|\b\d+% ?off\b|\bdiscount\b|\bon sale\b|\bfree (?:shipping|delivery|gift)\b|\bcheap(?:est)?\b|\blimited time\b|\bbuy (?:1|one) get\b)/i },
  { code: "SUPERLATIVE_UNPROVEN", severity: "WARNING", message: "Unproven superlative or ranking claim. Amazon may reject or customers may dispute it.", pattern: /\b(#1|no\.? ?1|number one|best[- ]?seller|world'?s best|best in (?:india|class|the world)|guaranteed|100% (?:safe|natural|pure))\b/i },
  { code: "REVIEW_OR_RATING_CLAIM", severity: "BLOCKER", message: "Do not mention reviews, ratings or testimonials in listing text.", pattern: /\b(5[- ]?star|five[- ]?star|rated \d|customer reviews?|top[- ]?rated|amazon'?s choice)\b/i },
  { code: "COMPETITOR_OR_EXTERNAL", severity: "BLOCKER", message: "Links, contact details or external-site references are not allowed.", pattern: /(https?:\/\/|www\.|\b[\w.-]+@[\w.-]+\.\w+\b|\bwhatsapp\b|\bflipkart\b|\bmeesho\b|\b\+?91[- ]?\d{10}\b)/i },
  { code: "PROMO_CHARACTERS", severity: "WARNING", message: "Decorative symbols or emoji are not allowed in listing text.", pattern: /[★☆✔✓✅❤♥●■◆►™®©!]{1}|[\u{1F300}-\u{1FAFF}]/u },
  { code: "SHOUTING", severity: "WARNING", message: "Too many ALL-CAPS words.", pattern: /(?:\b[A-Z]{4,}\b\s+){3,}/ }
];

export function checkListingCompliance(input: ComplianceInput): ComplianceFinding[] {
  const text = (input.text ?? "").trim();
  if (!text) return [];
  const known = (input.knownFacts ?? "").toLowerCase();
  const findings: ComplianceFinding[] = [];

  for (const rule of RULES) {
    const m = text.match(rule.pattern);
    if (!m) continue;
    if (rule.skipIfKnown && known && known.includes(m[0].toLowerCase())) continue;
    findings.push({ code: rule.code, severity: rule.severity, message: rule.message, match: m[0].slice(0, 40) });
  }

  const type = input.draftType.toUpperCase();
  if (type === "TITLE" && text.length > TITLE_MAX) {
    findings.push({ code: "TITLE_TOO_LONG", severity: "BLOCKER", message: `Title is ${text.length} characters; Amazon allows up to ${TITLE_MAX}.` });
  }
  if (type === "BULLETS") {
    const bullets = text.split(/\r?\n+/).map((b) => b.trim()).filter(Boolean);
    const long = bullets.find((b) => b.length > BULLET_MAX);
    if (long) findings.push({ code: "BULLET_TOO_LONG", severity: "BLOCKER", message: `A bullet point is ${long.length} characters; keep each under ${BULLET_MAX}.` });
    if (bullets.length > 5) findings.push({ code: "TOO_MANY_BULLETS", severity: "WARNING", message: `${bullets.length} bullets; Amazon shows 5.` });
  }
  if (type === "TITLE" && /\b(\w+)\b(?:\s+\1\b){2,}/i.test(text)) {
    findings.push({ code: "KEYWORD_STUFFING", severity: "WARNING", message: "A word is repeated 3+ times in a row (keyword stuffing)." });
  }
  return findings;
}

export function hasComplianceBlocker(findings: ComplianceFinding[]): boolean {
  return findings.some((f) => f.severity === "BLOCKER");
}

export function summarizeCompliance(findings: ComplianceFinding[]): string {
  if (findings.length === 0) return "Compliance check passed.";
  const b = findings.filter((f) => f.severity === "BLOCKER").length;
  const w = findings.length - b;
  return `Compliance check: ${b} blocker(s), ${w} warning(s) — ${findings.map((f) => f.code).join(", ")}.`;
}
