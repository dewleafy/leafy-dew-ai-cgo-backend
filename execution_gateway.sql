create table if not exists public.execution_attempts (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  action_id uuid null references public.action_ledger(id) on delete set null,
  source text null,
  source_id text null,
  action_type text not null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  execution_mode text not null default 'SHADOW',
  execution_status text not null,
  actor text not null default 'founder',
  request_payload jsonb not null default '{}'::jsonb,
  planned_change jsonb not null default '{}'::jsonb,
  snapshot_before jsonb null,
  snapshot_after jsonb null,
  rollback_snapshot jsonb null,
  safety_checks jsonb not null default '{}'::jsonb,
  blocked_reason text null,
  result_message text null,
  error_message text null,
  started_at timestamptz default now(),
  finished_at timestamptz null,
  created_at timestamptz default now()
);

create index if not exists idx_execution_attempts_seller_id on public.execution_attempts (seller_id);
create index if not exists idx_execution_attempts_action_id on public.execution_attempts (action_id);
create index if not exists idx_execution_attempts_action_type on public.execution_attempts (action_type);
create index if not exists idx_execution_attempts_execution_mode on public.execution_attempts (execution_mode);
create index if not exists idx_execution_attempts_execution_status on public.execution_attempts (execution_status);
create index if not exists idx_execution_attempts_created_at_desc on public.execution_attempts (created_at desc);
