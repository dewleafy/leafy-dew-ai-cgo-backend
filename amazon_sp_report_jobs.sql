create extension if not exists pgcrypto;

create table if not exists public.amazon_sp_report_jobs (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  marketplace_id text not null,
  report_id text not null unique,
  report_type text not null,
  job_type text not null,
  status text not null default 'PROCESSING',
  data_start_time timestamptz null,
  data_end_time timestamptz null,
  last_attempt_at timestamptz null,
  processed_at timestamptz null,
  error_message text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_amazon_sp_report_jobs_seller_id
  on public.amazon_sp_report_jobs (seller_id);

create index if not exists idx_amazon_sp_report_jobs_status
  on public.amazon_sp_report_jobs (status);

create index if not exists idx_amazon_sp_report_jobs_job_type
  on public.amazon_sp_report_jobs (job_type);

create index if not exists idx_amazon_sp_report_jobs_created_at
  on public.amazon_sp_report_jobs (created_at desc);
