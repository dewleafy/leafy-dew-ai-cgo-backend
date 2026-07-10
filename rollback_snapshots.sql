create extension if not exists pgcrypto;

create table if not exists public.rollback_snapshots (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  action_id uuid null references public.action_ledger(id) on delete set null,
  execution_attempt_id uuid null,
  source_module text not null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  snapshot_type text not null default 'PRE_CHANGE',
  snapshot_status text not null default 'CAPTURED',
  before_state jsonb not null default '{}'::jsonb,
  planned_change jsonb not null default '{}'::jsonb,
  after_state jsonb null,
  rollback_plan jsonb not null default '{}'::jsonb,
  rollback_status text not null default 'NOT_EXECUTED',
  captured_by text not null default 'system',
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_rollback_snapshots_seller_id
  on public.rollback_snapshots (seller_id);

create index if not exists idx_rollback_snapshots_action_id
  on public.rollback_snapshots (action_id);

create index if not exists idx_rollback_snapshots_execution_attempt_id
  on public.rollback_snapshots (execution_attempt_id);

create index if not exists idx_rollback_snapshots_source_module
  on public.rollback_snapshots (source_module);

create index if not exists idx_rollback_snapshots_entity_type
  on public.rollback_snapshots (entity_type);

create index if not exists idx_rollback_snapshots_entity_id
  on public.rollback_snapshots (entity_id);

create index if not exists idx_rollback_snapshots_sku
  on public.rollback_snapshots (sku);

create index if not exists idx_rollback_snapshots_asin
  on public.rollback_snapshots (asin);

create index if not exists idx_rollback_snapshots_snapshot_status
  on public.rollback_snapshots (snapshot_status);

create index if not exists idx_rollback_snapshots_rollback_status
  on public.rollback_snapshots (rollback_status);

create index if not exists idx_rollback_snapshots_created_at
  on public.rollback_snapshots (created_at desc);
