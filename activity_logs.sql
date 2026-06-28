create extension if not exists pgcrypto;

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
