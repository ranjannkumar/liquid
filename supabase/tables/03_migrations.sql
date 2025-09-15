-- supabase/tables/03_migrations.sql
-- Adds a dedicated column for the monthly token amount on yearly plans.
-- This prevents the bug where the full yearly token amount is credited each month.
ALTER TABLE public.subscription_prices
ADD COLUMN IF NOT EXISTS monthly_refill_tokens INTEGER;

-- You can optionally populate this column with data for existing plans:
-- For example, setting it to 1/12 of the yearly tokens for the 'ultra' plan.
-- UPDATE public.subscription_prices
-- SET monthly_refill_tokens = tokens / 12
-- WHERE plan_option = 'ultra' AND plan_type = 'yearly';