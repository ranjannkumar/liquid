-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “user_token_purchases” table
--    Records each time a user purchases a token plan via Stripe.
--    Columns include:
--      • id                   = Unique identifier for this purchase
--      • user_id              = Owner’s user ID (links to public.users.user_id)
--      • plan                 = Which token plan was purchased (e.g., 'tier1', 'tier2')
--      • stripe_purchase_id   = Stripe Checkout Session or Payment Intent ID
--      • is_active            = True if this purchase is currently active (false if refunded)
--      • current_period_start = When the purchased period began
--      • current_period_end   = When the purchased period ends (even if far in the future)
--      • amount               = Number of tokens acquired in this purchase
--      • created_at           = Timestamp when this purchase row was created
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_token_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),            -- Unique identifier for this purchase
  user_id UUID NOT NULL                                     -- References the purchaser’s user_id
    REFERENCES public.users(user_id),
  plan TEXT NOT NULL                                        -- Token plan identifier (e.g., 'tier1', 'tier2')
    ,
  stripe_purchase_id TEXT NOT NULL                          -- Stripe Checkout Session or Payment Intent ID
    ,
  is_active BOOLEAN DEFAULT TRUE,                           -- True if this purchase is active (false if refunded)
  current_period_start TIMESTAMP NOT NULL,                   -- When the purchased period began
  current_period_end TIMESTAMP NOT NULL,                     -- When the purchased period ends
  amount INTEGER NOT NULL,                                   -- Number of tokens acquired
  created_at TIMESTAMP DEFAULT NOW()                         -- Timestamp when this purchase was recorded
);
