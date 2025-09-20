-- Step 1: Drop the views that depend on the column.
-- This is necessary to remove the dependencies before altering the table.
DROP VIEW IF EXISTS public.user_token_summary;
DROP VIEW IF EXISTS public.user_token_total;

-- Step 2: Drop the obsolete column from the table.
-- This command safely removes the `consumed_pending` column.
ALTER TABLE public.user_token_batches
DROP COLUMN IF EXISTS consumed_pending;

-- Step 3: Recreate the "user_token_summary" view with the new logic.
CREATE OR REPLACE VIEW public.user_token_summary
WITH (security_invoker = on) AS
SELECT
  user_id,
  id                 AS batch_id,
  amount,
  consumed,
  (amount - consumed) AS available,
  expires_at,
  DATE_PART('day', expires_at - NOW())   AS days_until_expiry
FROM public.user_token_batches
WHERE is_active = TRUE
  AND (amount - consumed) > 0;

-- Step 4: Recreate the "user_token_total" view with the new logic.
CREATE OR REPLACE VIEW public.user_token_total
WITH (security_invoker = on) AS
SELECT
  user_id,
  SUM(amount - consumed) AS total_available
FROM public.user_token_batches
WHERE is_active = TRUE
  AND (amount - consumed) > 0
GROUP BY user_id;