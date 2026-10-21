-- Production hardening: direct-to-storage uploads, file metadata, query indexes.
--
-- Uploads no longer travel through the web server and the API. The API issues
-- a short-lived signed upload URL, the browser sends the file straight to
-- Storage, and the API verifies the stored object before any record may
-- reference it. Every issued URL is recorded as an upload intent so files that
-- are uploaded but never attached to a record can be swept automatically.

-- 1. File metadata on content: the portal shows what is attached, and
--    downloads keep the uploader's original file name.
alter table public.content_items
  add column if not exists file_name text,
  add column if not exists file_size bigint,
  add column if not exists mime_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'content_items_file_size_check'
  ) then
    alter table public.content_items
      add constraint content_items_file_size_check check (file_size is null or file_size >= 0);
  end if;
end;
$$;

-- 2. Upload intents. Only the service role (the API) touches this table.
create table if not exists public.upload_intents (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  path text not null unique,
  kind text not null check (kind in ('content', 'logo')),
  file_name text not null,
  declared_size bigint not null check (declared_size > 0),
  mime_type text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists upload_intents_pending_idx
  on public.upload_intents (expires_at)
  where consumed_at is null;

alter table public.upload_intents enable row level security;
-- Deliberately no policies: authenticated and anon roles have no access.

-- 3. Keep admin_profiles.updated_at honest without relying on every caller.
--    content_items is deliberately left out: the API stamps it on real edits,
--    and a trigger would also fire on bulk category renames and reshuffle
--    every "latest content" list.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists admin_profiles_set_updated_at on public.admin_profiles;
create trigger admin_profiles_set_updated_at
before update on public.admin_profiles
for each row execute function public.set_updated_at();

-- 4. Indexes for the queries the admin portal and field app actually run.
create index if not exists content_items_status_type_updated_idx
  on public.content_items (status, content_type, updated_at desc);
create index if not exists content_items_updated_idx
  on public.content_items (updated_at desc, id desc);
create index if not exists audit_events_created_idx
  on public.audit_events (created_at desc);
create index if not exists audit_events_entity_idx
  on public.audit_events (entity_type, entity_id);
create index if not exists admin_profiles_created_idx
  on public.admin_profiles (created_at desc);

-- 5. Storage: accept the modern Office formats field teams share (decks,
--    documents) and WebM/MOV video alongside the original set. The API still
--    sniffs every upload's leading bytes before a record may reference it.
update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ],
  file_size_limit = 52428800
where id = 'maypharm-admin-assets';

-- 6. Backfill file metadata for assets uploaded before this migration.
update public.content_items as items
set
  file_size = (objects.metadata ->> 'size')::bigint,
  mime_type = objects.metadata ->> 'mimetype'
from storage.objects as objects
where objects.bucket_id = items.storage_bucket
  and objects.name = items.storage_path
  and items.storage_path is not null
  and items.file_size is null;
