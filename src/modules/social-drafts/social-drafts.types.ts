export type SocialDraftStatus = "DRAFT" | "APPROVED" | "EDIT_REQUESTED" | "HELD";

export type SocialDraftPlatform = "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" | "PINTEREST" | "OTHER";

export type SocialDraftRow = {
  id: string;
  seller_id: string;
  content_log_id: string | null;
  planned_date: string | null;
  slot_time: string | null;
  platform: SocialDraftPlatform;
  format: string | null;
  occasion: string | null;
  caption: string;
  hashtags: string | null;
  creative_brief: string | null;
  checks: string | null;
  product_asin?: string | null;
  image_urls?: unknown;
  status: SocialDraftStatus;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeSocialDraft = {
  id: string;
  sellerId: string;
  contentLogId: string | null;
  plannedDate: string | null;
  slotTime: string | null;
  platform: SocialDraftPlatform;
  format: string | null;
  occasion: string | null;
  caption: string;
  hashtags: string | null;
  creativeBrief: string | null;
  checks: string | null;
  productAsin: string | null;
  imageUrls: string[];
  status: SocialDraftStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateSocialDraftInput = {
  sellerId: string;
  contentLogId: string | null;
  plannedDate: string | null;
  slotTime: string | null;
  platform: SocialDraftPlatform;
  format: string | null;
  occasion: string | null;
  caption: string;
  hashtags: string | null;
  creativeBrief: string | null;
  checks: string | null;
};

export type UpdateSocialDraftInput = {
  status?: SocialDraftStatus;
  caption?: string;
  hashtags?: string | null;
  decisionNote?: string | null;
};
