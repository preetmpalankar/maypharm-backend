-- Managed category list.
-- Categories stay denormalised as text on content_items and brands so every
-- existing filter, badge and ilike query keeps working; this table is the
-- controlled vocabulary the admin UI offers, and the backfill adopts whatever
-- was already typed by hand.

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  sort_order integer not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists categories_slug_key on public.categories (slug);
create unique index if not exists categories_name_lower_key on public.categories (lower(name));
create index if not exists categories_status_sort_idx on public.categories (status, sort_order, name);

create or replace function public.categories_before_write()
returns trigger
language plpgsql
as $$
declare
  base_slug text;
  candidate text;
  suffix integer := 1;
begin
  if coalesce(trim(new.slug), '') = '' then
    base_slug := public.maypharm_slugify(new.name);

    if base_slug = '' then
      base_slug := 'category';
    end if;

    candidate := base_slug;

    while exists (select 1 from public.categories where slug = candidate and id is distinct from new.id) loop
      suffix := suffix + 1;
      candidate := base_slug || '-' || suffix;
    end loop;

    new.slug := candidate;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists categories_before_write on public.categories;
create trigger categories_before_write
before insert or update on public.categories
for each row execute function public.categories_before_write();

-- Adopt every category already typed into content or brands.
with variants as (
  select trim(category) as name, lower(trim(category)) as name_key, count(*) as usage_count
  from (
    select category from public.content_items
    union all
    select category from public.brands
  ) as used
  where coalesce(trim(category), '') <> ''
    and public.maypharm_slugify(trim(category)) <> ''
  group by 1, 2
),
preferred as (
  select distinct on (name_key) name
  from variants
  order by
    name_key,
    usage_count desc,
    (name <> upper(name) and name <> lower(name)) desc,
    name
),
ranked as (
  select
    name,
    public.maypharm_slugify(name) as base_slug,
    row_number() over (partition by public.maypharm_slugify(name) order by name) as rank
  from preferred
)
insert into public.categories (name, slug)
select name, case when rank = 1 then base_slug else base_slug || '-' || rank end
from ranked
on conflict do nothing;

alter table public.categories enable row level security;

drop policy if exists "Authenticated users can read active categories" on public.categories;
create policy "Authenticated users can read active categories"
on public.categories for select
to authenticated
using (status = 'active');

drop policy if exists "Admins can manage categories" on public.categories;
create policy "Admins can manage categories"
on public.categories for all
to authenticated
using (public.is_admin())
with check (public.is_admin());
