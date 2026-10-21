-- Brands Library: brand-first navigation.
-- Every brand folder exposes the same three libraries (Product, Clinical, Media),
-- so content is tagged to a brand instead of only a free-text product name.

create or replace function public.maypharm_slugify(value text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '-', 'g'));
$$;

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null,
  category text not null default 'General',
  description text not null default '',
  logo_bucket text not null default 'maypharm-admin-assets',
  logo_path text,
  status text not null default 'active' check (status in ('active', 'archived')),
  sort_order integer not null default 0,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists brands_slug_key on public.brands (slug);
create unique index if not exists brands_name_lower_key on public.brands (lower(name));
create index if not exists brands_status_sort_idx on public.brands (status, sort_order, name);
create index if not exists brands_category_idx on public.brands (lower(category));

-- Slugs are derived from the brand name and stay unique without callers having to guess.
create or replace function public.brands_before_write()
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
      base_slug := 'brand';
    end if;

    candidate := base_slug;

    while exists (select 1 from public.brands where slug = candidate and id is distinct from new.id) loop
      suffix := suffix + 1;
      candidate := base_slug || '-' || suffix;
    end loop;

    new.slug := candidate;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists brands_before_write on public.brands;
create trigger brands_before_write
before insert or update on public.brands
for each row execute function public.brands_before_write();

alter table public.content_items
add column if not exists brand_id uuid references public.brands(id) on delete set null;

create index if not exists content_items_brand_idx on public.content_items (brand_id, content_type, status);

-- Backfill: every distinct product_name already in use becomes a brand folder.
with variants as (
  select
    trim(product_name) as name,
    lower(trim(product_name)) as name_key,
    coalesce(nullif(trim(category), ''), 'General') as category,
    count(*) as usage_count
  from public.content_items
  where coalesce(trim(product_name), '') <> ''
    and public.maypharm_slugify(trim(product_name)) <> ''
  group by 1, 2, 3
),
-- The same brand is often typed several ways. Collapse them case-insensitively
-- and keep the most-used spelling, preferring mixed case over ALL CAPS or all
-- lowercase so folder names read naturally.
preferred as (
  select distinct on (name_key)
    name,
    category
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
    category,
    public.maypharm_slugify(name) as base_slug,
    row_number() over (partition by public.maypharm_slugify(name) order by name) as rank
  from preferred
)
insert into public.brands (name, slug, category)
select
  name,
  case when rank = 1 then base_slug else base_slug || '-' || rank end,
  category
from ranked
on conflict do nothing;

update public.content_items as items
set brand_id = brands.id
from public.brands
where items.brand_id is null
  and lower(trim(items.product_name)) = lower(brands.name);

-- Per-brand item counts for the three library tiles, approved content only.
create or replace view public.brand_library_counts
with (security_invoker = on) as
select
  brands.id as brand_id,
  count(items.id) filter (where items.content_type in ('product', 'field_asset')) as product_count,
  count(items.id) filter (where items.content_type in ('clinical', 'regulatory')) as clinical_count,
  count(items.id) filter (where items.content_type = 'media') as media_count,
  count(items.id) as total_count
from public.brands
left join public.content_items as items
  on items.brand_id = brands.id and items.status = 'approved'
group by brands.id;

alter table public.brands enable row level security;

drop policy if exists "Authenticated users can read active brands" on public.brands;
create policy "Authenticated users can read active brands"
on public.brands for select
to authenticated
using (status = 'active');

drop policy if exists "Admins can manage brands" on public.brands;
create policy "Admins can manage brands"
on public.brands for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Brand logos live in the same private bucket and are streamed through the API.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]
where id = 'maypharm-admin-assets';
