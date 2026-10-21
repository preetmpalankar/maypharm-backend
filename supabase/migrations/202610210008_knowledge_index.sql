-- Knowledge index for the AI Assistant: every content item is turned into
-- searchable text chunks with embeddings (pgvector) and a knowledge graph of
-- the entities it mentions and how they relate.
--
-- Built by a background worker in the API from content_items as they are
-- created or edited; the upload flow neither writes nor reads these tables.
-- Only the service role (the API) has access: RLS is on with no policies.
-- Everything cascades from content_items, so deleting content deletes its
-- index. The assistant must filter to approved content at query time
-- (match_knowledge_chunks does by default), so drafts are indexed but never
-- surfaced.

create extension if not exists vector with schema extensions;

-- 1. Per-item indexing state: which version was indexed, and retry bookkeeping.
create table if not exists public.knowledge_index_state (
  content_id uuid primary key references public.content_items(id) on delete cascade,
  content_version timestamptz,
  content_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'indexed', 'failed')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  chunk_count integer not null default 0,
  entity_count integer not null default 0,
  relation_count integer not null default 0,
  embedding_model text,
  graph_model text,
  indexed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_index_state_status_idx
  on public.knowledge_index_state (status, next_attempt_at);

-- 2. Text chunks with embeddings (OpenAI text-embedding-3-small, 1536 dims).
create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content_items(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(1536) not null,
  token_estimate integer not null default 0,
  created_at timestamptz not null default now(),
  unique (content_id, chunk_index)
);

create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists knowledge_chunks_content_idx
  on public.knowledge_chunks (content_id);

-- 3. Knowledge graph. Entities are shared across content (one "Paracetamol"
--    node however many documents mention it); mentions and relations record
--    which content asserted them, so they are rebuilt per item.
create table if not exists public.kg_entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  entity_type text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_name, entity_type)
);

create table if not exists public.kg_mentions (
  entity_id uuid not null references public.kg_entities(id) on delete cascade,
  content_id uuid not null references public.content_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entity_id, content_id)
);

create index if not exists kg_mentions_content_idx on public.kg_mentions (content_id);

create table if not exists public.kg_relations (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content_items(id) on delete cascade,
  source_entity_id uuid not null references public.kg_entities(id) on delete cascade,
  target_entity_id uuid not null references public.kg_entities(id) on delete cascade,
  relation text not null,
  evidence text,
  created_at timestamptz not null default now()
);

create index if not exists kg_relations_content_idx on public.kg_relations (content_id);
create index if not exists kg_relations_source_idx on public.kg_relations (source_entity_id);
create index if not exists kg_relations_target_idx on public.kg_relations (target_entity_id);

alter table public.knowledge_index_state enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.kg_entities enable row level security;
alter table public.kg_mentions enable row level security;
alter table public.kg_relations enable row level security;
-- Deliberately no policies: only the service role reads or writes.

-- 4. Semantic search for the assistant: nearest chunks to a query embedding,
--    approved content only unless asked otherwise.
create or replace function public.match_knowledge_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  approved_only boolean default true
)
returns table (
  chunk_id uuid,
  content_id uuid,
  chunk_index integer,
  content text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    chunks.id,
    chunks.content_id,
    chunks.chunk_index,
    chunks.content,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks as chunks
  join public.content_items as items on items.id = chunks.content_id
  where not approved_only or items.status = 'approved'
  order by chunks.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

-- 5. Entities no longer mentioned by any content (after edits or deletes).
create or replace function public.kg_prune_orphan_entities()
returns integer
language sql
security invoker
set search_path = public
as $$
  with removed as (
    delete from public.kg_entities as entities
    where not exists (select 1 from public.kg_mentions where entity_id = entities.id)
      and not exists (
        select 1 from public.kg_relations
        where source_entity_id = entities.id or target_entity_id = entities.id
      )
    returning 1
  )
  select count(*)::integer from removed;
$$;

revoke all on function public.match_knowledge_chunks(extensions.vector, integer, boolean) from public, anon, authenticated;
revoke all on function public.kg_prune_orphan_entities() from public, anon, authenticated;
