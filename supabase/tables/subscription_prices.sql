-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “subscription_prices” table
--    Defines available subscription options, their billing intervals, token allotments, and prices.
--    Columns include:
--      • id           = Unique identifier for each price entry
--      • plan_option  = Subscription tier (must be one of 'daily', 'basic', 'standard', 'premium', 'ultra')
--      • plan_type    = Billing interval for this price ('daily', 'monthly', 'yearly')
--      • price_id     = Stripe Price ID (unique)
--      • tokens       = Number of tokens granted by this subscription option (must be > 0)
--      • price        = Price in USD (must be ≥ 0)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                                   -- Unique ID for this price entry
  plan_option TEXT NOT NULL                                                        -- Subscription tier (e.g., 'daily', 'basic', ...)
    CHECK (plan_option IN ('daily', 'basic', 'standard', 'premium', 'ultra')),
  plan_type TEXT NOT NULL                                                           -- Billing interval
    CHECK (plan_type IN ('daily', 'monthly', 'yearly')),
  price_id TEXT NOT NULL UNIQUE,                                                     -- Stripe Price ID (unique)
  tokens INTEGER NOT NULL                                                           -- Number of tokens granted by this subscription option
    CHECK (tokens > 0),
  price NUMERIC(10, 2) NOT NULL                                                     -- Price in USD
    CHECK (price >= 0)
);
