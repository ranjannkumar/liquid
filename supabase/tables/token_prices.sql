-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “token_prices” table
--    Defines available token‐purchase options (tiers) and their prices.
--    Columns include:
--      • id           = Unique identifier for each price entry
--      • plan_option  = Tier name (must be one of 'tier1'…'tier5')
--      • plan_type    = Always 'one_time' for these purchases
--      • price_id     = Stripe Price ID (unique)
--      • tokens       = Number of tokens granted by this plan (must be > 0)
--      • price        = Price in USD (must be ≥ 0)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.token_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                             -- Unique ID for this price entry
  plan_option TEXT NOT NULL                                                   -- Tier name (e.g., 'tier1', 'tier2', …)
    CHECK (plan_option IN ('tier1', 'tier2', 'tier3', 'tier4', 'tier5')),
  plan_type TEXT NOT NULL DEFAULT 'one_time',                                  -- Always 'one_time' for these purchases
  price_id TEXT NOT NULL UNIQUE                                                -- Stripe Price ID (unique)
    ,
  tokens INTEGER NOT NULL                                                      -- Number of tokens granted by this plan
    CHECK (tokens > 0),
  price NUMERIC(10, 2) NOT NULL                                                -- Price in USD
    CHECK (price >= 0)
);
