create extension if not exists pgcrypto;

create table if not exists public.maintenance_runs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  run_type text not null default 'MANUAL',
  run_status text not null default 'RUNNING',
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  safety_initialized boolean not null default false,
  alert_rules_seeded boolean not null default false,
  alerts_generated integer not null default 0,
  data_sources_checked integer not null default 0,
  learning_rebuilt boolean not null default false,
  health_status text null,
  warnings jsonb not null default '[]'::jsonb,
  results jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_maintenance_runs_seller_id
  on public.maintenance_runs (seller_id);

create index if not exists idx_maintenance_runs_run_type
  on public.maintenance_runs (run_type);

create index if not exists idx_maintenance_runs_run_status
  on public.maintenance_runs (run_status);

create index if not exists idx_maintenance_runs_started_at
  on public.maintenance_runs (started_at desc);
