-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create the “webhook_logs” table
--    Records all raw Stripe webhook events for auditing and replays.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,                       -- The Stripe event ID
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,                                -- 'pending', 'processed', 'error'
  created_at TIMESTAMP DEFAULT NOW()
);