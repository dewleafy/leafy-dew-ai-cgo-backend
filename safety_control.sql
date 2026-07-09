create extension if not exists pgcrypto;

create table if not exists public.safety_control_settings (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  global_mode text not null default 'SHADOW',
  live_execution_enabled boolean not null default false,
  ppc_live_execution_enabled boolean not null default false,
  listing_live_execution_enabled boolean not null default false,
  image_live_execution_enabled boolean not null default false,
  a_plus_live_execution_enabled boolean not null default false,
  social_live_execution_enabled boolean not null default false,
  ai_calls_enabled boolean not null default false,
  approval_required boolean not null default true,
  founder_approval_required boolean not null default true,
  max_daily_engine_runs integer not null default 50,
  max_daily_ai_cost numeric not null default 0,
  max_daily_execution_attempts integer not null default 25,
  approval_tier_rules jsonb not null default '{}'::jsonb,
  blocked_action_types jsonb not null default '[]'::jsonb,
  safety_notes text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_safety_control_settings_seller_unique
  on public.safety_control_settings (seller_id);

create index if not exists idx_safety_control_settings_seller_id
  on public.safety_control_settings (seller_id);

create index if not exists idx_safety_control_settings_global_mode
  on public.safety_control_settings (global_mode);

create index if not exists idx_safety_control_settings_updated_at_desc
  on public.safety_control_settings (updated_at desc);

create table if not exists public.safety_audit_events (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  event_type text not null,
  actor text not null default 'system',
  before_state jsonb null,
  after_state jsonb null,
  note text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_safety_audit_events_seller_id
  on public.safety_audit_events (seller_id);

create index if not exists idx_safety_audit_events_event_type
  on public.safety_audit_events (event_type);

create index if not exists idx_safety_audit_events_actor
  on public.safety_audit_events (actor);

create index if not exists idx_safety_audit_events_created_at_desc
  on public.safety_audit_events (created_at desc);
