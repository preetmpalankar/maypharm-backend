-- MayPharm AI Assistant: conversations and messages.
--
-- Each user's chats with the assistant, so history can be resumed, plus what
-- every answer cited (for compliance review). The API (service role) reads and
-- writes on the user's behalf after checking access; RLS also lets a signed-in
-- user read only their own conversations should a client query directly.
-- Requires 202610210008_knowledge_index.sql (the index the assistant searches).

create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_conversations_user_updated_idx
  on public.assistant_conversations (user_id, updated_at desc);

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- Sources the answer cited: [{index, contentId, title, contentType, ...}].
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'completed'
    check (status in ('completed', 'stopped', 'failed')),
  model text,
  usage jsonb,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists assistant_messages_conversation_idx
  on public.assistant_messages (conversation_id, created_at);

alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;

drop policy if exists "Users can read own conversations" on public.assistant_conversations;
create policy "Users can read own conversations"
on public.assistant_conversations for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can read own messages" on public.assistant_messages;
create policy "Users can read own messages"
on public.assistant_messages for select
to authenticated
using (
  exists (
    select 1 from public.assistant_conversations as conversations
    where conversations.id = conversation_id and conversations.user_id = auth.uid()
  )
);
