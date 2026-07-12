create extension if not exists pgcrypto;

create table if not exists public.scheduler_jobs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  job_key text not null,
  job_name text not null,
  job_type text not null,
  enabled boolean not null default true,
  schedule_hint text null,
  last_run_at timestamptz null,
  last_run_status text null,
  last_run_summary jsonb null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_scheduler_jobs_seller_key_unique
  on public.scheduler_jobs (seller_id, job_key);

create table if not exists public.scheduler_job_runs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  job_key text not null,
  run_status text not null default 'RUNNING',
  started_at timestamptz default now(),
  finished_at timestamptz null,
  result jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz default now()
);

create index if not exists idx_scheduler_job_runs_seller_id
  on public.scheduler_job_runs (seller_id);

create index if not exists idx_scheduler_job_runs_job_key
  on public.scheduler_job_runs (job_key);

create index if not exists idx_scheduler_job_runs_run_status
  on public.scheduler_job_runs (run_status);

create index if not exists idx_scheduler_job_runs_started_at_desc
  on public.scheduler_job_runs (started_at desc);
