-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “token_event_logs” table
--    A ledger of every token mutation (addition or consumption).
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.token_event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(user_id),
  batch_id UUID NOT NULL REFERENCES public.user_token_batches(id),
  delta INTEGER NOT NULL,                               -- Positive for credit, negative for debit
  reason TEXT NOT NULL,                                 -- E.g., 'purchase', 'subscription_refill', 'api_call'
  created_at TIMESTAMP DEFAULT NOW()
);