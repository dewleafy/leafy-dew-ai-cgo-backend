create table if not exists public.action_learning_events (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  action_id uuid null references public.action_ledger(id) on delete set null,
  engine_key text null,
  source text null,
  source_id text null,
  action_type text null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  event_type text not null,
  outcome_status text not null default 'RECORDED',
  actor text not null default 'system',
  note text null,
  before_metrics jsonb null,
  after_metrics jsonb null,
  observed_profit_impact numeric null,
  observed_sales_impact numeric null,
  observed_brand_impact numeric null,
  confidence_before text null,
  confidence_after text null,
  evidence jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_action_learning_events_seller_id on public.action_learning_events (seller_id);
create index if not exists idx_action_learning_events_action_id on public.action_learning_events (action_id);
create index if not exists idx_action_learning_events_engine_key on public.action_learning_events (engine_key);
create index if not exists idx_action_learning_events_source on public.action_learning_events (source);
create index if not exists idx_action_learning_events_action_type on public.action_learning_events (action_type);
create index if not exists idx_action_learning_events_sku on public.action_learning_events (sku);
create index if not exists idx_action_learning_events_asin on public.action_learning_events (asin);
create index if not exists idx_action_learning_events_event_type on public.action_learning_events (event_type);
create index if not exists idx_action_learning_events_created_at_desc on public.action_learning_events (created_at desc);

create table if not exists public.engine_learning_summary (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  engine_key text not null,
  total_actions_created integer not null default 0,
  approved_count integer not null default 0,
  rejected_count integer not null default 0,
  monitoring_count integer not null default 0,
  completed_count integer not null default 0,
  reopened_count integer not null default 0,
  duplicate_skipped_count integer not null default 0,
  no_action_count integer not null default 0,
  failed_count integer not null default 0,
  usefulness_score numeric not null default 50,
  confidence_score numeric not null default 50,
  last_learning_event_at timestamptz null,
  last_summary text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_engine_learning_summary_seller_engine
  on public.engine_learning_summary (seller_id, engine_key);
create index if not exists idx_engine_learning_summary_seller_id on public.engine_learning_summary (seller_id);
create index if not exists idx_engine_learning_summary_engine_key on public.engine_learning_summary (engine_key);
create index if not exists idx_engine_learning_summary_usefulness_desc on public.engine_learning_summary (usefulness_score desc);
create index if not exists idx_engine_learning_summary_confidence_desc on public.engine_learning_summary (confidence_score desc);
create index if not exists idx_engine_learning_summary_updated_at_desc on public.engine_learning_summary (updated_at desc);
