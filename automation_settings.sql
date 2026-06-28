create extension if not exists pgcrypto;

create table if not exists public.automation_settings (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  mode text not null default 'SHADOW' check (mode in ('SHADOW', 'APPROVAL', 'AUTO_LATER')),
  max_daily_recommendations integer not null default 10,
  target_acos_default numeric not null default 35,
  min_profit_low_price numeric not null default 60,
  min_profit_mid_price numeric not null default 110,
  allow_auto_negative boolean not null default false,
  allow_auto_bid_change boolean not null default false,
  allow_auto_budget_change boolean not null default false,
  allow_auto_keyword_add boolean not null default false,
  allow_auto_product_target_add boolean not null default false,
  allow_auto_listing_change boolean not null default false,
  allow_auto_price_change boolean not null default false,
  approval_required_for_tier_2 boolean not null default true,
  approval_required_for_tier_3 boolean not null default true,
  shadow_mode_days integer not null default 60,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_automation_settings_seller_id_unique
  on public.automation_settings (seller_id);

create index if not exists idx_automation_settings_seller_id
  on public.automation_settings (seller_id);
