-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “user_token_batches” table
--    Tracks each batch of tokens issued to a user, whether from a subscription or a purchase.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_token_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),        -- Unique identifier for this token batch
  user_id UUID NOT NULL                                 -- Owner’s user_id (references public.users.user_id)
    REFERENCES public.users(user_id),
  source TEXT NOT NULL                                  -- Source of tokens ('subscription', 'purchase', or 'referral')
    CHECK (source IN ('subscription', 'purchase', 'referral')),
  subscription_id UUID                                  -- References subscriptions(id), nullable if source != 'subscription'
    REFERENCES public.subscriptions(id),
  purchase_id UUID                                      -- References user_token_purchases(id), nullable if source != 'purchase'
    REFERENCES public.user_token_purchases(id),
  amount INTEGER NOT NULL,                               -- Total tokens issued in this batch
  consumed INTEGER DEFAULT 0,                             -- Tokens already used from this batch
  consumed_pending INTEGER DEFAULT 0,                     -- Tokens reserved but not yet consumed
    CHECK (consumed_pending >= 0),
  expires_at TIMESTAMP NOT NULL,                          -- Expiration timestamp for this batch
  is_active BOOLEAN DEFAULT TRUE,                         -- True if this batch is active (false if expired or disabled)
  created_at TIMESTAMP DEFAULT NOW()                     -- Timestamp when this batch was created
);