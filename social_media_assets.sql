-- Media Library for the social media agent: photos and videos stored in a public Supabase Storage bucket.
-- Instagram downloads media from a public URL, so the bucket is public. Only post-ready files belong here.
create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', true, 52428800, array['image/jpeg', 'video/mp4', 'video/quicktime'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.social_media_assets (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null default 'default',
  brand text not null default 'Leafy Dew',
  kind text not null default 'PHOTO',
  file_name text not null,
  storage_path text not null unique,
  public_url text not null,
  mime_type text not null,
  size_bytes bigint null,
  note text null,
  linked_draft_id uuid null references public.social_post_drafts(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint social_media_assets_kind_check check (kind in ('PHOTO', 'VIDEO'))
);

create index if not exists idx_social_media_assets_seller_created
  on public.social_media_assets (seller_id, created_at desc);

alter table public.social_media_assets enable row level security;
