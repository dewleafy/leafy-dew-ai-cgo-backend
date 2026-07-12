create extension if not exists pgcrypto;

create table if not exists public.live_execution_runs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  action_id uuid null references public.action_ledger(id) on delete set null,
  execution_attempt_id uuid null,
  rollback_snapshot_id uuid null,
  execution_domain text not null,
  action_type text not null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  live_status text not null default 'BLOCKED',
  dry_run_status text null,
  actor text not null default 'founder',
  confirm_text text null,
  request_payload jsonb not null default '{}'::jsonb,
  execution_plan jsonb not null default '{}'::jsonb,
  preflight_result jsonb not null default '{}'::jsonb,
  external_response jsonb null,
  blocked_reason text null,
  error_message text null,
  started_at timestamptz default now(),
  finished_at timestamptz null,
  created_at timestamptz default now()
);

create index if not exists idx_live_execution_runs_seller_id
  on public.live_execution_runs (seller_id);

create index if not exists idx_live_execution_runs_action_id
  on public.live_execution_runs (action_id);

create index if not exists idx_live_execution_runs_execution_domain
  on public.live_execution_runs (execution_domain);

create index if not exists idx_live_execution_runs_action_type
  on public.live_execution_runs (action_type);

create index if not exists idx_live_execution_runs_live_status
  on public.live_execution_runs (live_status);

create index if not exists idx_live_execution_runs_sku
  on public.live_execution_runs (sku);

create index if not exists idx_live_execution_runs_asin
  on public.live_execution_runs (asin);

create index if not exists idx_live_execution_runs_created_at_desc
  on public.live_execution_runs (created_at desc);
