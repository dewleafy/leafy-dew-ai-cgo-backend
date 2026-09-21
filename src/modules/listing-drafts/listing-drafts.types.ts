export type ListingDraftType =
  | "TITLE"
  | "BULLETS"
  | "BACKEND_KEYWORDS"
  | "DESCRIPTION"
  // Passport-only fields: these never go to Amazon. Approving one of these drafts just saves the
  // AI-authored text into the Product Passport itself (see passport-draft-execution module), which
  // is what the Brand Readiness score actually reads.
  | "BRAND_POSITIONING"
  | "CUSTOMER_OBJECTIONS"
  // Also passport-only. Unlike the two above (which are internal strategy notes), these describe
  // real, factual things about the product — so the AI drafter is deliberately restricted to
  // extracting only what's already explicitly stated in the seller's own real, synced Amazon
  // bullet points (never inventing package items or compliance/safety claims). See the
  // PACKAGE_CONTENTS/COMPLIANCE_NOTES prompts in listing-drafts.service.ts for the exact guardrail.
  | "PACKAGE_CONTENTS"
  | "COMPLIANCE_NOTES";

export type ListingOptimizationDraftRow = {
  id: string;
  seller_id: string;
  sku: string | null;
  asin: string | null;
  product_name: string | null;
  draft_type: ListingDraftType | string;
  current_value: string | null;
  proposed_value: string | null;
  reason: string | null;
  source: string;
  source_id: string | null;
  action_id: string | null;
  status: string;
  confidence_label: string;
  risk_level: string;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeListingOptimizationDraft = {
  id: string;
  sellerId: string;
  sku: string | null;
  asin: string | null;
  productName: string | null;
  // Real product photo URL for this draft's SKU/ASIN, filled in by listListingDrafts() from
  // Product Passport image data so the Listing Drafts page can show what the product actually
  // looks like. Null when no image is on file for this product yet.
  imageUrl: string | null;
  draftType: string;
  currentValue: string | null;
  proposedValue: string | null;
  reason: string | null;
  source: string;
  sourceId: string | null;
  actionId: string | null;
  status: string;
  confidenceLabel: string;
  riskLevel: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ListingDraftGenerateResult = {
  ok: true;
  sellerId: string;
  scannedCount: number;
  draftsCreated: number;
  actionsCreated: number;
  skippedCount: number;
  rows: SafeListingOptimizationDraft[];
};
