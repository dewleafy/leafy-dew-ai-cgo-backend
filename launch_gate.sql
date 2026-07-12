create extension if not exists pgcrypto;

create table if not exists public.launch_gate_checks (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  check_key text not null,
  check_name text not null,
  status text not null default 'UNKNOWN',
  severity text not null default 'HIGH',
  message text null,
  metadata jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_launch_gate_checks_seller_key_unique
  on public.launch_gate_checks (seller_id, check_key);

create index if not exists idx_launch_gate_checks_seller_id
  on public.launch_gate_checks (seller_id);

create index if not exists idx_launch_gate_checks_status
  on public.launch_gate_checks (status);

create index if not exists idx_launch_gate_checks_severity
  on public.launch_gate_checks (severity);

create index if not exists idx_launch_gate_checks_last_checked_at_desc
  on public.launch_gate_checks (last_checked_at desc);
