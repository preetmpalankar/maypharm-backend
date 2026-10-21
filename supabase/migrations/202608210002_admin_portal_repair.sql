create table if not exists public.admin_profiles (
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

create table if not exists public.content_items (
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

create table if not exists public.audit_events (
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

drop policy if exists "Admins can manage profiles" on public.admin_profiles;
create policy "Admins can manage profiles"
on public.admin_profiles for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Users can read own profile" on public.admin_profiles;
create policy "Users can read own profile"
on public.admin_profiles for select
to authenticated
using (id = auth.uid());

drop policy if exists "Admins and content teams can read content" on public.content_items;
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

drop policy if exists "Authenticated users can read approved content" on public.content_items;
create policy "Authenticated users can read approved content"
on public.content_items for select
to authenticated
using (status = 'approved');

drop policy if exists "Admins can manage content" on public.content_items;
create policy "Admins can manage content"
on public.content_items for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can read audit events" on public.audit_events;
create policy "Admins can read audit events"
on public.audit_events for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can write audit events" on public.audit_events;
create policy "Admins can write audit events"
on public.audit_events for insert
to authenticated
with check (public.is_admin());
