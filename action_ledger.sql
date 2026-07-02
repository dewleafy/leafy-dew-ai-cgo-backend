create table if not exists public.action_ledger (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  source text not null,
  source_id text null,
  action_type text not null,
  entity_type text null,
  entity_id text null,
  sku text null,
  asin text null,
  title text not null,
  summary text null,
  recommended_action text null,
  expected_profit_impact numeric null,
  expected_sales_impact numeric null,
  expected_brand_impact numeric null,
  risk_level text not null default 'MEDIUM',
  confidence_label text not null default 'MEDIUM',
  approval_tier text not null default 'TIER_2',
  requires_approval boolean not null default true,
  state text not null default 'DRAFTED',
  approval_status text not null default 'PENDING',
  payload jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  guardrails jsonb not null default '{}'::jsonb,
  rollback_snapshot jsonb null,
  approval_note text null,
  approved_by text null,
  approved_at timestamptz null,
  rejected_at timestamptz null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_action_ledger_seller_id on public.action_ledger (seller_id);
create index if not exists idx_action_ledger_state on public.action_ledger (state);
create index if not exists idx_action_ledger_approval_status on public.action_ledger (approval_status);
create index if not exists idx_action_ledger_action_type on public.action_ledger (action_type);
create index if not exists idx_action_ledger_sku on public.action_ledger (sku);
create index if not exists idx_action_ledger_asin on public.action_ledger (asin);
create index if not exists idx_action_ledger_created_at_desc on public.action_ledger (created_at desc);
