create extension if not exists pgcrypto;

create table if not exists public.qa_smoke_test_runs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  run_status text not null default 'RUNNING',
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  total_checks integer not null default 0,
  pass_count integer not null default 0,
  warn_count integer not null default 0,
  fail_count integer not null default 0,
  checks jsonb not null default '[]'::jsonb,
  blockers jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_qa_smoke_test_runs_seller_id
  on public.qa_smoke_test_runs (seller_id);

create index if not exists idx_qa_smoke_test_runs_run_status
  on public.qa_smoke_test_runs (run_status);

create index if not exists idx_qa_smoke_test_runs_started_at
  on public.qa_smoke_test_runs (started_at desc);
