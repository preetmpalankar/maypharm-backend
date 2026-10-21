alter table public.content_items
add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists content_items_metadata_gin_idx
on public.content_items using gin (metadata);
