-- Content bookmarks: users save approved content to find it again ("Saved" in
-- the mobile app). One row per user and item; deleting the user or the item
-- removes the bookmark. The API (service role) reads and writes on the user's
-- behalf after checking access, and RLS also lets a signed-in user manage only
-- their own rows should a client ever talk to the table directly.

create table if not exists public.content_bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  content_id uuid not null references public.content_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, content_id)
);

-- "My saved items, newest first".
create index if not exists content_bookmarks_user_created_idx
  on public.content_bookmarks (user_id, created_at desc);

-- Cascades from content_items deletes.
create index if not exists content_bookmarks_content_idx
  on public.content_bookmarks (content_id);

alter table public.content_bookmarks enable row level security;

drop policy if exists "Users can read own bookmarks" on public.content_bookmarks;
create policy "Users can read own bookmarks"
on public.content_bookmarks for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can add own bookmarks" on public.content_bookmarks;
create policy "Users can add own bookmarks"
on public.content_bookmarks for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can remove own bookmarks" on public.content_bookmarks;
create policy "Users can remove own bookmarks"
on public.content_bookmarks for delete
to authenticated
using (user_id = auth.uid());
