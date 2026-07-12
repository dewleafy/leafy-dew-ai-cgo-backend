create extension if not exists pgcrypto;

create table if not exists public.security_audit_events (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  actor text not null default 'unknown',
  event_type text not null,
  route text null,
  action text null,
  allowed boolean not null default false,
  reason text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_security_audit_events_seller_id
  on public.security_audit_events (seller_id);

create index if not exists idx_security_audit_events_actor
  on public.security_audit_events (actor);

create index if not exists idx_security_audit_events_event_type
  on public.security_audit_events (event_type);

create index if not exists idx_security_audit_events_allowed
  on public.security_audit_events (allowed);

create index if not exists idx_security_audit_events_created_at_desc
  on public.security_audit_events (created_at desc);
