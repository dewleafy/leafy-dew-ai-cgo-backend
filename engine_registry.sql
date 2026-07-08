create extension if not exists pgcrypto;

create table if not exists public.engine_registry (
  id uuid primary key default gen_random_uuid(),
  engine_key text not null unique,
  engine_name text not null,
  category text not null,
  subcategory text null,
  description text null,
  input_requirements jsonb not null default '[]'::jsonb,
  data_sources jsonb not null default '[]'::jsonb,
  rule_template text not null default 'GENERIC_REVIEW',
  rule_config jsonb not null default '{}'::jsonb,
  output_action_type text not null,
  output_entity_type text null,
  risk_level text not null default 'MEDIUM',
  cost_level text not null default 'LOW',
  priority_score numeric not null default 50,
  run_frequency text not null default 'DAILY',
  enabled boolean not null default true,
  shadow_mode boolean not null default true,
  requires_approval boolean not null default true,
  owner_module text null,
  version text not null default 'v1',
  last_run_at timestamptz null,
  last_run_status text null,
  last_run_summary text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_engine_registry_engine_key
  on public.engine_registry (engine_key);

create index if not exists idx_engine_registry_category
  on public.engine_registry (category);

create index if not exists idx_engine_registry_subcategory
  on public.engine_registry (subcategory);

create index if not exists idx_engine_registry_enabled
  on public.engine_registry (enabled);

create index if not exists idx_engine_registry_priority_score_desc
  on public.engine_registry (priority_score desc);

create index if not exists idx_engine_registry_risk_level
  on public.engine_registry (risk_level);

create index if not exists idx_engine_registry_last_run_at_desc
  on public.engine_registry (last_run_at desc);

create table if not exists public.engine_run_logs (
  id uuid primary key default gen_random_uuid(),
  engine_key text not null,
  seller_id text not null default 'default',
  run_status text not null,
  run_type text not null default 'MANUAL',
  input_snapshot jsonb null,
  output_snapshot jsonb null,
  actions_created_count integer not null default 0,
  error_message text null,
  started_at timestamptz default now(),
  finished_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_engine_run_logs_engine_key
  on public.engine_run_logs (engine_key);

create index if not exists idx_engine_run_logs_seller_id
  on public.engine_run_logs (seller_id);

create index if not exists idx_engine_run_logs_run_status
  on public.engine_run_logs (run_status);

create index if not exists idx_engine_run_logs_started_at_desc
  on public.engine_run_logs (started_at desc);
