create extension if not exists pgcrypto;

create table if not exists public.action_workflow_events (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.action_ledger(id) on delete cascade,
  seller_id text not null default 'default',
  from_state text null,
  to_state text not null,
  event_type text not null,
  actor text not null default 'system',
  note text null,
  snapshot_before jsonb null,
  snapshot_after jsonb null,
  rollback_snapshot jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_action_workflow_events_action_id
  on public.action_workflow_events (action_id);

create index if not exists idx_action_workflow_events_seller_id
  on public.action_workflow_events (seller_id);

create index if not exists idx_action_workflow_events_event_type
  on public.action_workflow_events (event_type);

create index if not exists idx_action_workflow_events_to_state
  on public.action_workflow_events (to_state);

create index if not exists idx_action_workflow_events_created_at_desc
  on public.action_workflow_events (created_at desc);
