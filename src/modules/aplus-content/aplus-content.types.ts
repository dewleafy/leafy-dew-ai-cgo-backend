export type AplusContentStatus = "FOUND" | "NOT_FOUND" | "APPROVED" | "SUBMITTED" | "REJECTED" | "DRAFT";

export type NormalizedAplusBlock = {
  headline?: string;
  body?: string;
  image?: string;
};

export type NormalizedAplusModule = {
  type: string;
  headline?: string;
  body?: string;
  images: string[];
  items: NormalizedAplusBlock[];
};

export type AplusContentCacheRow = {
  id: string;
  seller_id: string;
  asin: string;
  content_reference_key: string | null;
  status: AplusContentStatus;
  content_module_list: NormalizedAplusModule[];
  fetched_at: string;
  created_at: string;
  updated_at: string;
};

export type AplusContentReport = {
  ok: true;
  asin: string;
  status: AplusContentStatus;
  moduleCount: number;
  modules: NormalizedAplusModule[];
  fetchedAt: string;
  source: "CACHED" | "FETCHED_LIVE";
  warning?: string;
};
