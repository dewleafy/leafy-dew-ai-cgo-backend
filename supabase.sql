create extension if not exists pgcrypto;

create table if not exists public.amazon_connections (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null unique,
  amazon_seller_id text,
  region text not null check (region in ('NA', 'EU', 'FE')),
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error')),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.amazon_tokens (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique references public.amazon_connections(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  token_type text not null default 'bearer',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.amazon_marketplaces (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.amazon_connections(id) on delete cascade,
  marketplace_id text not null,
  name text not null,
  country_code text not null,
  default_currency_code text,
  default_language_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, marketplace_id)
);

create table if not exists public.amazon_api_logs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.amazon_connections(id) on delete set null,
  seller_id text,
  endpoint text not null,
  method text not null,
  status_code integer,
  success boolean not null,
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.amazon_connections(id) on delete cascade,
  job_type text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists amazon_connections_seller_id_idx
  on public.amazon_connections (seller_id);

create index if not exists amazon_marketplaces_connection_id_idx
  on public.amazon_marketplaces (connection_id);

create index if not exists amazon_api_logs_connection_id_created_at_idx
  on public.amazon_api_logs (connection_id, created_at desc);

create index if not exists sync_jobs_connection_id_status_idx
  on public.sync_jobs (connection_id, status);

alter table public.amazon_connections enable row level security;
alter table public.amazon_tokens enable row level security;
alter table public.amazon_marketplaces enable row level security;
alter table public.amazon_api_logs enable row level security;
alter table public.sync_jobs enable row level security;

-- Security note:
-- No public RLS policies are created here. The backend uses SUPABASE_SERVICE_ROLE_KEY
-- on the server only. Never expose the service role key in frontend code.
