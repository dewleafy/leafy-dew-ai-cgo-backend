create extension if not exists pgcrypto;

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  channel text not null,
  recipient text null,
  subject text null,
  message text not null,
  status text not null default 'QUEUED',
  source_module text null,
  source_id text null,
  severity text not null default 'INFO',
  send_attempts integer not null default 0,
  last_error text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  sent_at timestamptz null
);

create index if not exists idx_notification_outbox_seller_id
  on public.notification_outbox (seller_id);

create index if not exists idx_notification_outbox_channel
  on public.notification_outbox (channel);

create index if not exists idx_notification_outbox_status
  on public.notification_outbox (status);

create index if not exists idx_notification_outbox_created_at_desc
  on public.notification_outbox (created_at desc);

create table if not exists public.notification_settings (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  external_notifications_enabled boolean not null default false,
  email_enabled boolean not null default false,
  whatsapp_enabled boolean not null default false,
  slack_enabled boolean not null default false,
  default_email text null,
  default_phone text null,
  default_slack_webhook text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_notification_settings_seller_unique
  on public.notification_settings (seller_id);
