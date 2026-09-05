export type ListingDraftType = "TITLE" | "BULLETS" | "BACKEND_KEYWORDS" | "DESCRIPTION";

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
