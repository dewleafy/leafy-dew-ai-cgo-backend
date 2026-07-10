create extension if not exists pgcrypto;

create table if not exists public.activity_log_events (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  event_type text not null,
  event_category text not null,
  severity text not null default 'INFO' check (severity in ('INFO', 'SUCCESS', 'WARNING', 'ERROR', 'CRITICAL')),
  actor text not null default 'system',
  title text not null,
  message text null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  action_id uuid null references public.action_ledger(id) on delete set null,
  source_module text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_log_events_seller_id
  on public.activity_log_events (seller_id);

create index if not exists idx_activity_log_events_event_type
  on public.activity_log_events (event_type);

create index if not exists idx_activity_log_events_event_category
  on public.activity_log_events (event_category);

create index if not exists idx_activity_log_events_severity
  on public.activity_log_events (severity);

create index if not exists idx_activity_log_events_actor
  on public.activity_log_events (actor);

create index if not exists idx_activity_log_events_entity_type
  on public.activity_log_events (entity_type);

create index if not exists idx_activity_log_events_entity_id
  on public.activity_log_events (entity_id);

create index if not exists idx_activity_log_events_sku
  on public.activity_log_events (sku);

create index if not exists idx_activity_log_events_asin
  on public.activity_log_events (asin);

create index if not exists idx_activity_log_events_action_id
  on public.activity_log_events (action_id);

create index if not exists idx_activity_log_events_source_module
  on public.activity_log_events (source_module);

create index if not exists idx_activity_log_events_created_at
  on public.activity_log_events (created_at desc);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  event_type text not null,
  entity_type text null,
  entity_id text null,
  entity_label text null,
  action text not null,
  status text not null default 'INFO' check (status in ('INFO', 'SUCCESS', 'WARNING', 'ERROR')),
  message text null,
  metadata jsonb not null default '{}'::jsonb,
  user_note text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_logs_seller_id
  on public.activity_logs (seller_id);

create index if not exists idx_activity_logs_event_type
  on public.activity_logs (event_type);

create index if not exists idx_activity_logs_entity_type
  on public.activity_logs (entity_type);

create index if not exists idx_activity_logs_entity_id
  on public.activity_logs (entity_id);

create index if not exists idx_activity_logs_status
  on public.activity_logs (status);

create index if not exists idx_activity_logs_created_at
  on public.activity_logs (created_at desc);
