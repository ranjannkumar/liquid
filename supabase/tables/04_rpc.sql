-- supabase/tables/04_rpc.sql
-- New file to add the atomic token consumption function.

-- Create a function to safely consume tokens and log the event.
-- This replaces the client-side transaction logic in token_service.
CREATE OR REPLACE FUNCTION public.consume_tokens(
  p_user_id UUID,
  p_amount INTEGER,
  p_reason TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_remaining INTEGER := p_amount;
  v_consumed  INTEGER := 0;
  v_batch_id  UUID;
  v_available INTEGER;
BEGIN
  -- Find active batches for the user, ordered by earliest expiry (FIFO).
  FOR v_batch_id, v_available IN
    SELECT id, (amount - consumed - consumed_pending)
    FROM public.user_token_batches
    WHERE user_id = p_user_id
      AND is_active = TRUE
      AND (amount - consumed - consumed_pending) > 0
    ORDER BY expires_at ASC
  LOOP
    IF v_remaining <= 0 THEN
      EXIT;
    END IF;

    -- Take as many tokens as needed from this batch.
    DECLARE
      v_take_amount INTEGER := LEAST(v_remaining, v_available);
    BEGIN
      UPDATE public.user_token_batches
      SET consumed = consumed + v_take_amount
      WHERE id = v_batch_id;

      v_remaining := v_remaining - v_take_amount;
      v_consumed := v_consumed + v_take_amount;

      -- Log the token consumption
      INSERT INTO public.token_event_logs (user_id, batch_id, delta, reason)
      VALUES (p_user_id, v_batch_id, -v_take_amount, p_reason);
    END;
  END LOOP;
  
  -- If not enough tokens were consumed, raise an error
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Insufficient tokens available. Requested: %, Consumed: %', p_amount, v_consumed;
  END IF;

  RETURN v_consumed;

END;
$$;

-- Grant usage and execute permissions
GRANT EXECUTE ON FUNCTION public.consume_tokens(UUID, INTEGER, TEXT) TO authenticated, service_role;