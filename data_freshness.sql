create extension if not exists pgcrypto;

create table if not exists public.data_freshness_status (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  data_source text not null,
  last_success_at timestamptz null,
  last_attempt_at timestamptz null,
  status text not null default 'UNKNOWN',
  freshness_minutes integer null,
  stale_after_minutes integer not null default 1440,
  last_error text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_data_freshness_status_seller_source_unique
  on public.data_freshness_status (seller_id, data_source);

create index if not exists idx_data_freshness_status_seller_id
  on public.data_freshness_status (seller_id);

create index if not exists idx_data_freshness_status_data_source
  on public.data_freshness_status (data_source);

create index if not exists idx_data_freshness_status_status
  on public.data_freshness_status (status);

create index if not exists idx_data_freshness_status_updated_at_desc
  on public.data_freshness_status (updated_at desc);
