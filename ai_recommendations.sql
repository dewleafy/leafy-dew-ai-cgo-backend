create extension if not exists pgcrypto;

create table if not exists public.ai_recommendations (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  source text not null default 'PPC_RECOMMENDATION_BRAIN',
  recommendation_type text not null,
  recommended_action text not null,
  entity_type text null,
  entity_value text null,
  campaign_id text null,
  campaign_name text null,
  ad_group_id text null,
  ad_group_name text null,
  sku text null,
  asin text null,
  priority_score numeric default 0,
  priority_label text default 'LOW',
  confidence_score numeric default 0,
  confidence_label text default 'LOW',
  approval_tier text default 'TIER_1',
  requires_approval boolean default true,
  risk_level text default 'LOW',
  expected_profit_impact numeric null,
  reason text not null,
  evidence jsonb default '{}'::jsonb,
  profit_evidence jsonb default '{}'::jsonb,
  status text default 'NEW',
  user_note text null,
  rule_version text default 'profit_ppc_v1',
  strategy_version text default 'ai_cgo_v2_2_shadow_mode',
  data_start_date date null,
  data_end_date date null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_ai_recommendations_seller_id
  on public.ai_recommendations (seller_id);

create index if not exists idx_ai_recommendations_status
  on public.ai_recommendations (status);

create index if not exists idx_ai_recommendations_recommendation_type
  on public.ai_recommendations (recommendation_type);

create index if not exists idx_ai_recommendations_entity_value
  on public.ai_recommendations (entity_value);

create index if not exists idx_ai_recommendations_created_at_desc
  on public.ai_recommendations (created_at desc);

create unique index if not exists idx_ai_recommendations_unique_shadow_action
  on public.ai_recommendations (
    seller_id,
    entity_value,
    recommended_action,
    rule_version,
    data_start_date,
    data_end_date
  )
  where entity_value is not null;
