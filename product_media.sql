create extension if not exists pgcrypto;

create table if not exists public.product_media (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  sku text null,
  asin text null,
  product_name text null,
  main_image_url text null,
  image_urls jsonb not null default '[]'::jsonb,
  image_source text null,
  image_status text null,
  catalog_payload jsonb null,
  last_image_sync_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.product_media
  add column if not exists seller_id text not null default 'default',
  add column if not exists sku text null,
  add column if not exists asin text null,
  add column if not exists product_name text null,
  add column if not exists main_image_url text null,
  add column if not exists image_urls jsonb not null default '[]'::jsonb,
  add column if not exists image_source text null,
  add column if not exists image_status text null,
  add column if not exists catalog_payload jsonb null,
  add column if not exists last_image_sync_at timestamptz null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

drop index if exists public.idx_product_media_seller_asin_unique;

drop index if exists public.idx_product_media_seller_sku_unique;

create unique index if not exists product_media_seller_asin_uidx
  on public.product_media (seller_id, asin)
  where asin is not null;

create unique index if not exists product_media_seller_sku_uidx
  on public.product_media (seller_id, sku)
  where sku is not null;

create index if not exists idx_product_media_seller_id
  on public.product_media (seller_id);

create index if not exists idx_product_media_asin
  on public.product_media (asin);

create index if not exists idx_product_media_sku
  on public.product_media (sku);

create index if not exists idx_product_media_image_status
  on public.product_media (image_status);
