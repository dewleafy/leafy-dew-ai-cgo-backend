create extension if not exists pgcrypto;

create table if not exists public.recommendation_outcomes (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  recommendation_id uuid not null references public.ai_recommendations(id) on delete cascade,
  experiment_id uuid null references public.experiments(id) on delete set null,
  outcome_status text not null default 'NEEDS_MORE_DATA' check (
    outcome_status in ('WORKED', 'FAILED', 'NEEDS_MORE_DATA', 'PARTIAL', 'NOT_APPLICABLE')
  ),
  evaluation_window_days integer not null default 7,
  before_metrics jsonb not null default '{}'::jsonb,
  after_metrics jsonb not null default '{}'::jsonb,
  profit_impact numeric null,
  sales_impact numeric null,
  cost_impact numeric null,
  acos_before numeric null,
  acos_after numeric null,
  orders_before integer null,
  orders_after integer null,
  confidence_after numeric null,
  result_summary text null,
  learning_note text null,
  evaluated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_recommendation_outcomes_seller_id
  on public.recommendation_outcomes (seller_id);

create index if not exists idx_recommendation_outcomes_recommendation_id
  on public.recommendation_outcomes (recommendation_id);

create index if not exists idx_recommendation_outcomes_experiment_id
  on public.recommendation_outcomes (experiment_id);

create index if not exists idx_recommendation_outcomes_outcome_status
  on public.recommendation_outcomes (outcome_status);

create index if not exists idx_recommendation_outcomes_created_at
  on public.recommendation_outcomes (created_at desc);
