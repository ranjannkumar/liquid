-- 1) Drop the existing function to avoid conflicts
DROP FUNCTION IF EXISTS public.trigger_run_subscription_maintenance();

-- 2) Recreate the function with an explicit, immutable search_path
--    Adding “SET search_path = public, pg_catalog” ensures that any referenced
--    objects (e.g., net.http_post) resolve in the public schema safely.
CREATE OR REPLACE FUNCTION public.trigger_run_subscription_maintenance()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
    service_key TEXT := 'service_role_key';  
    edge_url    TEXT := 'https://YOUR_PROJECT_ID.supabase.co/functions/v1/run_subscription_maintenance';
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

-- 3) (Re)create the cron job to invoke the function every hour at minute 0
SELECT cron.unschedule('cron_run_subscription_maintenance');

SELECT cron.schedule(
  'cron_run_subscription_maintenance',
  '0 * * * *',
  $$ SELECT public.trigger_run_subscription_maintenance(); $$
);
