create extension if not exists pgcrypto;

create table if not exists public.amazon_sp_connections (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  amazon_seller_id text null,
  marketplace_id text not null,
  region text not null,
  refresh_token_encrypted text null,
  token_status text not null default 'DISCONNECTED',
  last_connected_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_amazon_sp_connections_seller_marketplace_unique
  on public.amazon_sp_connections (seller_id, marketplace_id);

create index if not exists idx_amazon_sp_connections_seller_id
  on public.amazon_sp_connections (seller_id);

create table if not exists public.amazon_sp_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  amazon_seller_id text null,
  marketplace_id text not null,
  sku text not null,
  asin text null,
  product_name text null,
  listing_status text null,
  fulfillment_channel text null,
  price numeric null,
  currency text null,
  quantity integer null,
  product_type text null,
  main_image_url text null,
  raw_payload jsonb null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_amazon_sp_listings_seller_marketplace_sku_unique
  on public.amazon_sp_listings (seller_id, marketplace_id, sku);

create index if not exists idx_amazon_sp_listings_seller_id
  on public.amazon_sp_listings (seller_id);

create index if not exists idx_amazon_sp_listings_asin
  on public.amazon_sp_listings (asin);

create table if not exists public.amazon_sp_orders (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  marketplace_id text not null,
  amazon_order_id text not null,
  purchase_date timestamptz null,
  order_status text null,
  fulfillment_channel text null,
  sales_channel text null,
  order_total_amount numeric null,
  order_total_currency text null,
  number_of_items_shipped integer null,
  number_of_items_unshipped integer null,
  raw_payload jsonb null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_amazon_sp_orders_seller_order_unique
  on public.amazon_sp_orders (seller_id, amazon_order_id);

create index if not exists idx_amazon_sp_orders_seller_id
  on public.amazon_sp_orders (seller_id);

create index if not exists idx_amazon_sp_orders_purchase_date
  on public.amazon_sp_orders (purchase_date desc);

create table if not exists public.amazon_sp_order_items (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  amazon_order_id text not null,
  order_item_id text not null,
  asin text null,
  sku text null,
  title text null,
  quantity_ordered integer null,
  quantity_shipped integer null,
  item_price_amount numeric null,
  item_price_currency text null,
  item_tax_amount numeric null,
  promotion_discount_amount numeric null,
  raw_payload jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_amazon_sp_order_items_seller_item_unique
  on public.amazon_sp_order_items (seller_id, order_item_id);

create index if not exists idx_amazon_sp_order_items_seller_id
  on public.amazon_sp_order_items (seller_id);

create index if not exists idx_amazon_sp_order_items_order_id
  on public.amazon_sp_order_items (amazon_order_id);

create index if not exists idx_amazon_sp_order_items_sku
  on public.amazon_sp_order_items (sku);
