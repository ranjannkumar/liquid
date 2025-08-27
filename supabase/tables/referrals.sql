-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “referrals” table
--    Tracks referral relationships and reward status.
--    Columns include:
--      • id             = Unique identifier for this referral record
--      • referrer_user_id = The user who sent the invite
--      • referred_user_id = The user who signed up and paid
--      • is_rewarded    = True once the reward has been granted
--      • created_at     = When this referral was recorded
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL
    REFERENCES public.users(user_id),
  referred_user_id UUID NOT NULL
    REFERENCES public.users(user_id) UNIQUE, -- Ensure each referred user is unique
  is_rewarded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);