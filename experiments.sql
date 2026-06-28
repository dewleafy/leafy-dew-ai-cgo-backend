create extension if not exists pgcrypto;

create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  experiment_name text not null,
  experiment_type text not null,
  product_passport_id uuid null,
  sku text null,
  asin text null,
  campaign_id text null,
  ad_group_id text null,
  recommendation_id uuid null,
  hypothesis text null,
  expected_result text null,
  success_metric text null,
  before_metrics jsonb not null default '{}'::jsonb,
  after_metrics jsonb not null default '{}'::jsonb,
  result_summary text null,
  learning_note text null,
  status text not null default 'PLANNED',
  priority text not null default 'MEDIUM',
  start_date date null,
  end_date date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_experiments_seller_id
  on public.experiments (seller_id);

create index if not exists idx_experiments_status
  on public.experiments (status);

create index if not exists idx_experiments_experiment_type
  on public.experiments (experiment_type);

create index if not exists idx_experiments_product_passport_id
  on public.experiments (product_passport_id);

create index if not exists idx_experiments_recommendation_id
  on public.experiments (recommendation_id);
