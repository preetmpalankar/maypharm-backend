create type public.app_role as enum ('admin', 'medical', 'marketing', 'sales', 'viewer');
create type public.profile_status as enum ('invited', 'active', 'suspended');
create type public.content_status as enum ('draft', 'review', 'approved', 'archived');
create type public.content_type as enum ('product', 'clinical', 'academy', 'media', 'field_asset', 'regulatory');

create table public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  role public.app_role not null default 'viewer',
  territory text,
  status public.profile_status not null default 'invited',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content_type public.content_type not null,
  category text not null,
  product_name text,
  description text not null,
  status public.content_status not null default 'draft',
  storage_bucket text not null default 'maypharm-admin-assets',
  storage_path text,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles
    where id = auth.uid() and role = 'admin' and status in ('active', 'invited')
  );
$$;

alter table public.admin_profiles enable row level security;
alter table public.content_items enable row level security;
alter table public.audit_events enable row level security;

create policy "Admins can manage profiles"
on public.admin_profiles for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Users can read own profile"
on public.admin_profiles for select
to authenticated
using (id = auth.uid());

create policy "Admins and content teams can read content"
on public.content_items for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.admin_profiles
    where id = auth.uid() and role in ('medical', 'marketing', 'sales') and status = 'active'
  )
);

create policy "Authenticated users can read approved content"
on public.content_items for select
to authenticated
using (status = 'approved');

create policy "Admins can manage content"
on public.content_items for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins can read audit events"
on public.audit_events for select
to authenticated
using (public.is_admin());

create policy "Admins can write audit events"
on public.audit_events for insert
to authenticated
with check (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'maypharm-admin-assets',
  'maypharm-admin-assets',
  false,
  52428800,
  array['application/pdf','image/png','image/jpeg','video/mp4','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do nothing;

create policy "Admins can upload admin assets"
on storage.objects for insert
to authenticated
with check (bucket_id = 'maypharm-admin-assets' and public.is_admin());

create policy "Admins can read admin assets"
on storage.objects for select
to authenticated
using (bucket_id = 'maypharm-admin-assets' and public.is_admin());

-- Deliberately no broad authenticated read policy for storage.objects.
-- Approved metadata can be listed from content_items, but binary assets remain private
-- and should only be streamed through a controlled backend route with short TTLs,
-- no-store headers, entitlement checks, and audit logging.

create policy "Admins can update admin assets"
on storage.objects for update
to authenticated
using (bucket_id = 'maypharm-admin-assets' and public.is_admin())
with check (bucket_id = 'maypharm-admin-assets' and public.is_admin());

create policy "Admins can delete admin assets"
on storage.objects for delete
to authenticated
using (bucket_id = 'maypharm-admin-assets' and public.is_admin());
