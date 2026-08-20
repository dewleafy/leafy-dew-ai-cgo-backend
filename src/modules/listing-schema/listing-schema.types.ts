export type AmazonSchemaCacheRow = {
  id: string;
  product_type: string;
  marketplace_id: string;
  required_attributes: string[];
  schema_checksum: string | null;
  fetched_at: string;
  created_at: string;
  updated_at: string;
};

export type SchemaAttributeStatus = {
  attribute: string;
  label: string;
  status: "KNOWN" | "MISSING" | "UNTRACKED";
};

export type SchemaReadinessReport = {
  ok: true;
  sku: string;
  productType: string | null;
  marketplaceId: string;
  schemaSource: "CACHED" | "FETCHED_LIVE" | "UNAVAILABLE";
  requiredAttributeCount: number;
  attributes: SchemaAttributeStatus[];
  missingCount: number;
  untrackedCount: number;
  readyForSubmission: boolean;
  summaryMessage: string;
  checkedAt: string;
  warning?: string;
};
