-- Description (in English):
-- These two views provide a summary of a user’s token batches and a total count of available tokens across all active batches.
--
-- 1. user_token_summary:
--    - Selects all active token batches (`user_token_batches`) where the available token count (amount - consumed - consumed_pending) is greater than zero.
--    - Columns returned:
--        • user_id               = the UUID of the user.
--        • batch_id              = the primary key (id) of the token batch.
--        • amount                = total number of tokens in that batch.
--        • consumed              = number of tokens already marked as consumed.
--        • consumed_pending      = number of tokens currently reserved (pending).
--        • available              = computed as (amount - consumed - consumed_pending).
--        • expires_at            = timestamp when this batch will expire.
--        • days_until_expiry     = number of days remaining until `expires_at` (DATE_PART('day', expires_at - NOW())).
--    - Only includes rows where:
--        • is_active = true
--        • available > 0 (i.e., there is at least one token left to use).
--
-- 2. user_token_total:
--    - Aggregates per-user the total number of available tokens across all their active batches.
--    - Columns returned:
--        • user_id         = the UUID of the user.
--        • total_available = SUM(amount - consumed - consumed_pending) over all active batches with available > 0.
--    - Only includes rows where:
--        • is_active = true
--        • available > 0
--    - Groups by user_id, so each user appears once with their total available token count.


-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Create or replace the “user_token_summary” view
--    This view shows each active token batch for a user, including:
--      • batch_id          = the token batch’s primary key (id)
--      • amount            = total tokens in the batch
--      • consumed          = tokens already used
--      • consumed_pending  = tokens reserved but not yet consumed
--      • available         = tokens still usable (amount − consumed − consumed_pending)
--      • expires_at        = when this batch expires
--      • days_until_expiry = how many days remain until expiration
--    We filter only “active” batches and those with a positive available balance.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.user_token_summary
WITH (security_invoker = on) AS
SELECT
  user_id,
  id                 AS batch_id,
  amount,
  consumed,
  consumed_pending,
  (amount - consumed - consumed_pending) AS available,
  expires_at,
  DATE_PART('day', expires_at - NOW())   AS days_until_expiry
FROM public.user_token_batches
WHERE is_active = TRUE
  AND (amount - consumed - consumed_pending) > 0;


-- ──────────────────────────────────────────────────────────────────────────────
-- 2) Create or replace the “user_token_total” view
--    This view aggregates all active, positive‐balance token batches per user,
--    returning the total available tokens for each user.
--      • total_available = SUM(amount − consumed − consumed_pending) grouped by user_id
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.user_token_total
WITH (security_invoker = on) AS
SELECT
  user_id,
  SUM(amount - consumed - consumed_pending) AS total_available
FROM public.user_token_batches
WHERE is_active = TRUE
  AND (amount - consumed - consumed_pending) > 0
GROUP BY user_id;


-- ──────────────────────────────────────────────────────────────────────────────
-- 3) Revoke any PUBLIC grants on both views to prevent unauthorized access
-- ──────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON public.user_token_summary FROM PUBLIC;
REVOKE ALL ON public.user_token_total   FROM PUBLIC;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4) Grant SELECT on these views:
--    • “authenticated” users can query their own token data (underlying RLS on user_token_batches
--      must already enforce row‐level filtering by user_id).
--    • “service_role” (backend processes) can also query as needed.
--    No INSERT/UPDATE/DELETE is allowed on a view.
-- ──────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON public.user_token_summary TO authenticated;
GRANT SELECT ON public.user_token_summary TO service_role;

GRANT SELECT ON public.user_token_total TO authenticated;
GRANT SELECT ON public.user_token_total TO service_role;
