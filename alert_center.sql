create extension if not exists pgcrypto;

create table if not exists public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  rule_key text not null,
  rule_name text not null,
  category text not null,
  severity text not null default 'MEDIUM',
  enabled boolean not null default true,
  condition_config jsonb not null default '{}'::jsonb,
  cooldown_hours integer not null default 24,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_alert_rules_seller_rule_unique
  on public.alert_rules (seller_id, rule_key);

create index if not exists idx_alert_rules_seller_id
  on public.alert_rules (seller_id);

create index if not exists idx_alert_rules_rule_key
  on public.alert_rules (rule_key);

create table if not exists public.alert_events (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  rule_key text null,
  category text not null,
  severity text not null default 'MEDIUM',
  title text not null,
  message text not null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  action_id uuid null references public.action_ledger(id) on delete set null,
  status text not null default 'OPEN',
  source text not null default 'ALERT_CENTER',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  acknowledged_at timestamptz null,
  resolved_at timestamptz null
);

create index if not exists idx_alert_events_seller_id
  on public.alert_events (seller_id);

create index if not exists idx_alert_events_rule_key
  on public.alert_events (rule_key);

create index if not exists idx_alert_events_category
  on public.alert_events (category);

create index if not exists idx_alert_events_severity
  on public.alert_events (severity);

create index if not exists idx_alert_events_status
  on public.alert_events (status);

create index if not exists idx_alert_events_sku
  on public.alert_events (sku);

create index if not exists idx_alert_events_asin
  on public.alert_events (asin);

create index if not exists idx_alert_events_created_at_desc
  on public.alert_events (created_at desc);
