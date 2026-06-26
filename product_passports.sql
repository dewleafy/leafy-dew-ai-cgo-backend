create extension if not exists pgcrypto;

create table if not exists public.product_passports (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  sku text null,
  asin text null,
  product_name text not null,
  brand text null default 'Leafy Dew',
  category text null,
  sub_category text null,
  product_type text null,
  selling_price numeric null,
  target_customer text null,
  use_case text null,
  material text null,
  color text null,
  dimensions text null,
  weight text null,
  package_contents text null,
  key_features jsonb not null default '[]'::jsonb,
  customer_objections jsonb not null default '[]'::jsonb,
  competitor_asins jsonb not null default '[]'::jsonb,
  image_urls jsonb not null default '[]'::jsonb,
  supplier_name text null,
  supplier_cost numeric null,
  packaging_notes text null,
  brand_positioning text null,
  seo_keywords jsonb not null default '[]'::jsonb,
  compliance_notes text null,
  internal_notes text null,
  status text not null default 'DRAFT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_passports_seller_id
  on public.product_passports (seller_id);

create index if not exists idx_product_passports_sku
  on public.product_passports (sku);

create index if not exists idx_product_passports_asin
  on public.product_passports (asin);

create index if not exists idx_product_passports_status
  on public.product_passports (status);

create unique index if not exists idx_product_passports_unique_seller_sku
  on public.product_passports (seller_id, sku)
  where sku is not null;

create unique index if not exists idx_product_passports_unique_seller_asin
  on public.product_passports (seller_id, asin)
  where asin is not null;
