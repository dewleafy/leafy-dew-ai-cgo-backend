create table if not exists public.listing_optimization_drafts (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  sku text null,
  asin text null,
  product_name text null,
  draft_type text not null,
  current_value text null,
  proposed_value text null,
  reason text null,
  source text not null default 'LISTING_DRAFT_SYSTEM',
  source_id text null,
  action_id uuid null references public.action_ledger(id) on delete set null,
  status text not null default 'DRAFTED',
  confidence_label text not null default 'MEDIUM',
  risk_level text not null default 'MEDIUM',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_listing_optimization_drafts_seller_id on public.listing_optimization_drafts (seller_id);
create index if not exists idx_listing_optimization_drafts_sku on public.listing_optimization_drafts (sku);
create index if not exists idx_listing_optimization_drafts_asin on public.listing_optimization_drafts (asin);
create index if not exists idx_listing_optimization_drafts_draft_type on public.listing_optimization_drafts (draft_type);
create index if not exists idx_listing_optimization_drafts_status on public.listing_optimization_drafts (status);
create index if not exists idx_listing_optimization_drafts_created_at_desc on public.listing_optimization_drafts (created_at desc);
