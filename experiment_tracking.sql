create extension if not exists pgcrypto;

create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  experiment_key text null,
  name text not null,
  description text null,
  experiment_type text not null,
  status text not null default 'DRAFT',
  action_id uuid null references public.action_ledger(id) on delete set null,
  engine_key text null,
  sku text null,
  asin text null,
  hypothesis text null,
  baseline_metrics jsonb not null default '{}'::jsonb,
  target_metrics jsonb not null default '{}'::jsonb,
  current_metrics jsonb not null default '{}'::jsonb,
  result_summary text null,
  result_status text null,
  started_at timestamptz null,
  ended_at timestamptz null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  experiment_name text null,
  product_passport_id uuid null,
  campaign_id text null,
  ad_group_id text null,
  recommendation_id uuid null,
  expected_result text null,
  success_metric text null,
  before_metrics jsonb not null default '{}'::jsonb,
  after_metrics jsonb not null default '{}'::jsonb,
  learning_note text null,
  priority text not null default 'MEDIUM',
  start_date date null,
  end_date date null
);

alter table public.experiments add column if not exists experiment_key text null;
alter table public.experiments add column if not exists name text null;
alter table public.experiments add column if not exists description text null;
alter table public.experiments add column if not exists action_id uuid null references public.action_ledger(id) on delete set null;
alter table public.experiments add column if not exists engine_key text null;
alter table public.experiments add column if not exists baseline_metrics jsonb not null default '{}'::jsonb;
alter table public.experiments add column if not exists target_metrics jsonb not null default '{}'::jsonb;
alter table public.experiments add column if not exists current_metrics jsonb not null default '{}'::jsonb;
alter table public.experiments add column if not exists result_status text null;
alter table public.experiments add column if not exists started_at timestamptz null;
alter table public.experiments add column if not exists ended_at timestamptz null;

update public.experiments
set name = coalesce(name, experiment_name, 'Untitled experiment')
where name is null;

alter table public.experiments alter column name set not null;

create table if not exists public.experiment_events (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  experiment_id uuid references public.experiments(id) on delete cascade,
  event_type text not null,
  actor text not null default 'system',
  note text null,
  metrics_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_experiments_seller_id
  on public.experiments (seller_id);

create index if not exists idx_experiments_status
  on public.experiments (status);

create index if not exists idx_experiments_experiment_type
  on public.experiments (experiment_type);

create index if not exists idx_experiments_action_id
  on public.experiments (action_id);

create index if not exists idx_experiments_engine_key
  on public.experiments (engine_key);

create index if not exists idx_experiments_sku
  on public.experiments (sku);

create index if not exists idx_experiments_asin
  on public.experiments (asin);

create index if not exists idx_experiments_created_at_desc
  on public.experiments (created_at desc);

create index if not exists idx_experiment_events_seller_id
  on public.experiment_events (seller_id);

create index if not exists idx_experiment_events_experiment_id
  on public.experiment_events (experiment_id);

create index if not exists idx_experiment_events_event_type
  on public.experiment_events (event_type);

create index if not exists idx_experiment_events_created_at_desc
  on public.experiment_events (created_at desc);
