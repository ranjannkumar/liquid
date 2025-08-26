-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “users” table
--    This table stores a record for each end user, synchronized with Supabase Auth.
--    Columns track creation time, link to auth.users, subscription/payment flags, and soft-delete.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),      -- Unique internal ID for this record
  created_at TIMESTAMP DEFAULT NOW(),                 -- When this row was first inserted
  user_id UUID NOT NULL UNIQUE,                       -- Supabase Auth user ID (links to auth.users.id)
  email TEXT NOT NULL UNIQUE,                         -- User’s email address (must be unique)
  has_active_subscription BOOLEAN DEFAULT FALSE,      -- “true” if user currently has a paid subscription
  has_payment_issue BOOLEAN DEFAULT FALSE,            -- “true” if there is a payment failure on their account
  is_deleted BOOLEAN DEFAULT FALSE                    -- Soft-delete flag; when true, treat as “blocked”
);
