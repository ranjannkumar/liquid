-- supabase/cronjobs/run_subscription_maintenance.sql
-- Corrected file for T11.
-- 1) Drop the existing function to avoid conflicts
DROP FUNCTION IF EXISTS public.trigger_run_subscription_maintenance();

-- 2) Recreate the function with an explicit, immutable search_path
CREATE OR REPLACE FUNCTION public.trigger_run_subscription_maintenance()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
    service_key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0dHBmcHpnZW5ldXVvbm50aHR6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjE5NTExMCwiZXhwIjoyMDcxNzcxMTEwfQ.1rSimLghNGB7nucwkliIbIvOTODXvv6ataMNPt5jRhs';  
    edge_url    TEXT := 'https://tttpfpzgeneuuonnthtz.supabase.co/functions/v1/run_subscription_maintenance';
BEGIN
  RAISE NOTICE '📡 Trigger: run_subscription_maintenance...';

  PERFORM net.http_post(
    url     := edge_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body    := '{}'::jsonb
  );
END;
$$;

-- 3) (Re)create the cron job to invoke the function every day at 00:05 UTC.
-- This aligns with the spec's recommendation.
SELECT cron.unschedule('cron_run_subscription_maintenance');

SELECT cron.schedule(
  'cron_run_subscription_maintenance',
  '5 0 * * *',
  $$ SELECT public.trigger_run_subscription_maintenance(); $$
);