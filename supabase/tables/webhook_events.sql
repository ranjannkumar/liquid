create table if not exists public.webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
