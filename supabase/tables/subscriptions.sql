-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “subscriptions” table
--    Records each user’s active or historical subscription, including billing cycle,
--    Stripe subscription ID, token allotment, and renewal dates. Columns include:
--      • id                    = Unique identifier for this subscription record
--      • user_id               = Owner’s user ID (references public.users.user_id)
--      • plan                  = Subscription tier (e.g., 'basic', 'premium')
--      • billing_cycle         = Billing interval ('daily', 'monthly', 'yearly')
--      • stripe_subscription_id= Stripe Subscription ID for billing management
--      • is_active             = True if the subscription is currently active (false if canceled)
--      • current_period_start  = When the current billing period began
--      • current_period_end    = When the current billing period ends
--      • amount                = Number of tokens granted at the start of each period
--      • last_monthly_refill   = Timestamp of last monthly refill (used for yearly plans)
--      • created_at            = When this subscription record was created
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),           -- Unique identifier for this subscription record
  user_id UUID NOT NULL                                    -- Owner’s user_id (references public.users.user_id)
    REFERENCES public.users(user_id),
  plan TEXT NOT NULL                                        -- Subscription tier (e.g., 'basic', 'premium')
    ,
  billing_cycle TEXT NOT NULL                               -- Billing interval
    CHECK (billing_cycle IN ('daily', 'monthly', 'yearly')),
  stripe_subscription_id TEXT NOT NULL                       -- Stripe Subscription ID
    ,
  is_active BOOLEAN DEFAULT TRUE,                            -- True if currently active; false if canceled
  current_period_start TIMESTAMP NOT NULL,                    -- When the current billing period began
  current_period_end TIMESTAMP NOT NULL,                      -- When the current billing period ends
  amount INTEGER NOT NULL,                                    -- Tokens granted at the start of each period
  last_monthly_refill TIMESTAMP,                              -- Timestamp of last monthly refill (for yearly plans)
  created_at TIMESTAMP DEFAULT NOW()                          -- When this subscription record was created
);
