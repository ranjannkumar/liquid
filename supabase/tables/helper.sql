ALTER TABLE public.users
ADD COLUMN stripe_customer_id TEXT UNIQUE;


-- Step 1: Drop the existing constraint
-- Note: Your constraint name might be slightly different.
-- If this fails, find the exact name in the Supabase UI under Database > Tables > user_token_batches > Constraints.
ALTER TABLE public.user_token_batches
DROP CONSTRAINT user_token_batches_source_check;
-- Step 2: Add the new, updated constraint
ALTER TABLE public.user_token_batches
ADD CONSTRAINT user_token_batches_source_check
CHECK (source IN ('subscription', 'purchase', 'referral'));


ALTER TABLE public.subscriptions
ADD CONSTRAINT subscriptions_stripe_subscription_id_key
UNIQUE (stripe_subscription_id);


create table if not exists public.webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);




alter table public.user_token_purchases
  add constraint user_token_purchases_stripe_purchase_id_key
  unique (stripe_purchase_id);


alter table public.subscriptions
  alter column current_period_start drop not null,
  alter column current_period_end drop not null;



alter table public.user_token_batches
  add column if not exists consumed int4 default 0 not null,
  add column if not exists is_active boolean default true not null,
  add column if not exists expires_at timestamp null;
