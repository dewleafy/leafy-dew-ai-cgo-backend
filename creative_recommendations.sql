create table if not exists public.creative_recommendations (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  sku text null,
  asin text null,
  product_name text null,
  recommendation_type text not null,
  title text not null,
  summary text null,
  recommended_action text null,
  source text not null default 'CREATIVE_RECOMMENDATION_SYSTEM',
  source_id text null,
  action_id uuid null references public.action_ledger(id) on delete set null,
  status text not null default 'DRAFTED',
  confidence_label text not null default 'MEDIUM',
  risk_level text not null default 'MEDIUM',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_creative_recommendations_seller_id on public.creative_recommendations (seller_id);
create index if not exists idx_creative_recommendations_sku on public.creative_recommendations (sku);
create index if not exists idx_creative_recommendations_asin on public.creative_recommendations (asin);
create index if not exists idx_creative_recommendations_recommendation_type on public.creative_recommendations (recommendation_type);
create index if not exists idx_creative_recommendations_status on public.creative_recommendations (status);
create index if not exists idx_creative_recommendations_created_at_desc on public.creative_recommendations (created_at desc);
