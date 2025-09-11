-- supabase/tables/02_migrations.sql
-- New file to add a column for T1
ALTER TABLE public.user_token_purchases
ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) DEFAULT 0.00;