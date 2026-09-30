export type SocialContentPlatform = "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" | "PINTEREST" | "OTHER";

export type SocialContentStatus = "PLANNED" | "POSTED" | "SKIPPED";

export type SocialContentLogRow = {
  id: string;
  seller_id: string;
  platform: SocialContentPlatform;
  content_type: string | null;
  title: string | null;
  sku: string | null;
  asin: string | null;
  status: SocialContentStatus;
  planned_date: string | null;
  posted_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SafeSocialContentLogRow = {
  id: string;
  sellerId: string;
  platform: SocialContentPlatform;
  contentType: string | null;
  title: string | null;
  sku: string | null;
  asin: string | null;
  status: SocialContentStatus;
  plannedDate: string | null;
  postedDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateSocialContentLogInput = {
  sellerId: string;
  platform: SocialContentPlatform;
  contentType: string | null;
  title: string | null;
  sku: string | null;
  asin: string | null;
  status: SocialContentStatus;
  plannedDate: string | null;
  postedDate: string | null;
  notes: string | null;
};

export type UpdateSocialContentLogInput = Partial<CreateSocialContentLogInput>;

// Real, computed-from-real-rows summary used by the Social Content engines (SOCIAL_CALENDAR_CHECK)
// so the gap check is based on genuine logged activity, never a guess.
export type SocialContentCalendarSummary = {
  totalLoggedEver: number;
  postedInWindowCount: number;
  mostRecentPostedDate: string | null;
  daysSinceLastPost: number | null;
  nextPlannedDate: string | null;
  daysUntilNextPlanned: number | null;
};
