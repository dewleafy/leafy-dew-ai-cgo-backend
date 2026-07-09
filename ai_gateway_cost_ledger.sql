create extension if not exists pgcrypto;

create table if not exists public.ai_cost_ledger (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  request_id text null,
  module_name text not null,
  purpose text null,
  provider text null,
  model_name text null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost numeric not null default 0,
  actual_cost numeric null,
  status text not null default 'RECORDED',
  blocked_reason text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.ai_gateway_settings (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  ai_calls_enabled boolean not null default false,
  daily_budget numeric not null default 0,
  monthly_budget numeric not null default 0,
  allowed_modules jsonb not null default '[]'::jsonb,
  blocked_modules jsonb not null default '[]'::jsonb,
  default_provider text null,
  default_model text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_ai_gateway_settings_seller_unique
  on public.ai_gateway_settings (seller_id);

create index if not exists idx_ai_cost_ledger_seller_id
  on public.ai_cost_ledger (seller_id);

create index if not exists idx_ai_cost_ledger_module_name
  on public.ai_cost_ledger (module_name);

create index if not exists idx_ai_cost_ledger_status
  on public.ai_cost_ledger (status);

create index if not exists idx_ai_cost_ledger_created_at_desc
  on public.ai_cost_ledger (created_at desc);

create index if not exists idx_ai_gateway_settings_seller_id
  on public.ai_gateway_settings (seller_id);
