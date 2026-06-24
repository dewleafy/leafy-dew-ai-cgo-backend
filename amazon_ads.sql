create extension if not exists pgcrypto;

create table if not exists public.amazon_ads_connections (
  id uuid primary key default gen_random_uuid(),
  seller_id text,
  region text not null check (region in ('NA', 'EU', 'FE')),
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error')),
  state_nonce text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists amazon_ads_connections_seller_id_unique_idx
  on public.amazon_ads_connections (seller_id)
  where seller_id is not null;

create table if not exists public.amazon_ads_tokens (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique references public.amazon_ads_connections(id) on delete cascade,
  encrypted_refresh_token text not null,
  token_type text not null default 'bearer',
  scopes text[] not null default array['advertising::campaign_management'],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.amazon_ads_profiles (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.amazon_ads_connections(id) on delete cascade,
  profile_id text not null,
  country_code text,
  currency_code text,
  timezone text,
  account_info jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, profile_id)
);

create table if not exists public.amazon_ads_api_logs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.amazon_ads_connections(id) on delete set null,
  endpoint text not null,
  method text not null,
  status_code integer,
  success boolean not null,
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.amazon_ads_campaigns (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.amazon_ads_connections(id) on delete cascade,
  profile_id text not null,
  seller_id text,
  campaign_id text not null,
  name text,
  campaign_type text,
  targeting_type text,
  state text,
  status text,
  daily_budget numeric,
  start_date text,
  end_date text,
  raw_data jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, campaign_id)
);

create index if not exists amazon_ads_connections_status_idx
  on public.amazon_ads_connections (status);

create index if not exists amazon_ads_profiles_connection_id_idx
  on public.amazon_ads_profiles (connection_id);

create index if not exists amazon_ads_api_logs_connection_id_created_at_idx
  on public.amazon_ads_api_logs (connection_id, created_at desc);

create index if not exists amazon_ads_campaigns_connection_profile_idx
  on public.amazon_ads_campaigns (connection_id, profile_id);

create index if not exists amazon_ads_campaigns_seller_id_idx
  on public.amazon_ads_campaigns (seller_id);

alter table public.amazon_ads_connections enable row level security;
alter table public.amazon_ads_tokens enable row level security;
alter table public.amazon_ads_profiles enable row level security;
alter table public.amazon_ads_api_logs enable row level security;
alter table public.amazon_ads_campaigns enable row level security;

-- Security note:
-- No public RLS policies are created here. The backend should use the
-- SUPABASE_SERVICE_ROLE_KEY on the server only. Never expose that key in frontend code.
