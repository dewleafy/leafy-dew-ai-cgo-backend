create extension if not exists pgcrypto;

create table if not exists public.daily_orchestrator_runs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  run_type text not null default 'MANUAL',
  run_status text not null,
  started_at timestamptz default now(),
  finished_at timestamptz null,
  engines_planned integer not null default 0,
  engines_run integer not null default 0,
  actions_created integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  approval_pending_before integer null,
  approval_pending_after integer null,
  data_readiness jsonb not null default '{}'::jsonb,
  engine_summary jsonb not null default '{}'::jsonb,
  action_summary jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_daily_orchestrator_runs_seller_id
  on public.daily_orchestrator_runs (seller_id);

create index if not exists idx_daily_orchestrator_runs_run_status
  on public.daily_orchestrator_runs (run_status);

create index if not exists idx_daily_orchestrator_runs_started_at_desc
  on public.daily_orchestrator_runs (started_at desc);

create index if not exists idx_daily_orchestrator_runs_run_type
  on public.daily_orchestrator_runs (run_type);
