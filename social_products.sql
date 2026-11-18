-- Product list for the social media agent and the public link-in-bio shop page.
-- Only post_status = 'OK' products are shown publicly or used in automatic posts.
create extension if not exists pgcrypto;

create table if not exists public.social_products (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  brand text not null default 'Leafy Dew',
  asin text not null,
  sku text null,
  title text null,
  family text null,
  buyer_link text not null,
  attribution_link text null,
  listing_status text null,
  photo_count integer null,
  post_status text not null default 'OK',
  post_notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_products_post_status_check check (post_status in ('OK', 'OWNER_CHECK', 'HOLD')),
  constraint social_products_unique_asin unique (seller_id, asin)
);

create index if not exists idx_social_products_seller_family on public.social_products (seller_id, family);
alter table public.social_products enable row level security;
