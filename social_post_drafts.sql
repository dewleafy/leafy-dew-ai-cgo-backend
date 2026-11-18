-- Social media drafts queue ("Needs your OK").
-- A draft is written by the content writer for one planned post. Approving a draft only records
-- the owner's decision. Nothing here publishes to any platform.
create extension if not exists pgcrypto;

create table if not exists public.social_post_drafts (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  content_log_id uuid null references public.social_content_log(id) on delete set null,
  planned_date date null,
  slot_time text null,
  platform text not null default 'INSTAGRAM',
  format text null,
  occasion text null,
  caption text not null,
  hashtags text null,
  creative_brief text null,
  checks text null,
  status text not null default 'DRAFT',
  decision_note text null,
  decided_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_post_drafts_status_check
    check (status in ('DRAFT', 'APPROVED', 'EDIT_REQUESTED', 'HELD')),
  constraint social_post_drafts_platform_check
    check (platform in ('INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'PINTEREST', 'OTHER'))
);

create index if not exists idx_social_post_drafts_seller_date
  on public.social_post_drafts (seller_id, planned_date);

create index if not exists idx_social_post_drafts_status
  on public.social_post_drafts (status);

alter table public.social_post_drafts enable row level security;

-- Product and photos used by a draft (added with the photo-post writer).
alter table public.social_post_drafts add column if not exists product_asin text null;
alter table public.social_post_drafts add column if not exists image_urls jsonb not null default '[]'::jsonb;
