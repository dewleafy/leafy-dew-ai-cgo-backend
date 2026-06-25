create extension if not exists pgcrypto;

create table if not exists public.amazon_product_economics (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  marketplace_id text null,
  asin text null,
  sku text null,
  product_name text null,
  selling_price numeric not null,
  landed_cost numeric default 0,
  packaging_cost numeric default 0,
  amazon_fee_estimate numeric default 0,
  shipping_fee_estimate numeric default 0,
  tax_estimate numeric default 0,
  return_rate_percent numeric default 0,
  return_cost_per_return numeric default 0,
  return_reserve_per_unit numeric default 0,
  influencer_cost_allocation_per_unit numeric default 0,
  social_marketing_cost_per_unit numeric default 0,
  coupon_discount_estimate numeric default 0,
  other_cost_per_unit numeric default 0,
  target_profit numeric not null,
  target_profit_rule text null,
  non_ad_cost numeric default 0,
  max_allowable_ad_spend numeric default 0,
  break_even_acos numeric default 0,
  target_acos numeric default 0,
  profit_status text default 'UNKNOWN',
  notes text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_amazon_product_economics_seller_id
  on public.amazon_product_economics (seller_id);

create index if not exists idx_amazon_product_economics_asin
  on public.amazon_product_economics (asin);

create index if not exists idx_amazon_product_economics_sku
  on public.amazon_product_economics (sku);
