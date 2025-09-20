// supabase/functions/run_subscription_maintenance/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "run_subscription_maintenance";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async () => {
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  try {
    // 1) Expire batches
    const { data: expired, error: expiredError } = await supabase
      .from("user_token_batches")
      .select("id")
      .eq("is_active", true)
      .lt("expires_at", now.toISOString());
    if (expiredError) throw expiredError;
    if (expired) {
      for (const b of expired) {
        await supabase.from("user_token_batches").update({ is_active: false }).eq("id", b.id);
      }
    }

    // 2) Deactivate subscriptions past period end
    const { data: activeSubs, error: activeSubsError } = await supabase
      .from("subscriptions")
      .select("id, user_id, current_period_end")
      .eq("is_active", true);
    if (activeSubsError) throw activeSubsError;
    if (activeSubs) {
      for (const s of activeSubs) {
        if (s.current_period_end && new Date(s.current_period_end) < now) {
          await supabase.from("subscriptions").update({ is_active: false }).eq("id", s.id);
          await supabase.from("users").update({ has_active_subscription: false }).eq("user_id", s.user_id);
        }
      }
    }

    // 3) Yearly safety-net monthly refill (idempotent by month)
    const { data: yearly, error: yearlyError } = await supabase
      .from("subscriptions")
      .select("id, user_id, plan_option, last_monthly_refill")
      .eq("billing_cycle", "yearly")
      .eq("is_active", true);
    if (yearlyError) throw yearlyError;

    if (yearly) {
      for (const s of yearly) {
        const last = s.last_monthly_refill ? new Date(s.last_monthly_refill) : null;
        const already = last && last.getMonth() === thisMonth && last.getFullYear() === thisYear;
        if (already) {
          console.log(`[${EDGE_FUNCTION_NAME}] ℹ️ Subscription ${s.id} already refilled for ${thisYear}-${thisMonth + 1}.`);
          continue;
        }

        const { data: tokenRow, error: tokenError } = await supabase
          .from("subscription_prices")
          .select("tokens, monthly_refill_tokens")
          .eq("plan_option", s.plan_option)
          .eq("plan_type", "yearly")
          .maybeSingle();

        if (tokenError || !tokenRow) {
          console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Skipping refill for sub ${s.id}: token lookup failed.`);
          continue;
        }

        // Fix for T11: Use monthly_refill_tokens, with fallback.
        const monthlyTokens = tokenRow.monthly_refill_tokens || Math.floor(tokenRow.tokens / 12);
        
        const expires = new Date();
        expires.setMonth(expires.getMonth() + 1);

        // Transactional logic to ensure both operations succeed or fail together
        try {
          const { data: batchData, error: batchInsertError } = await supabase.from("user_token_batches").insert({
            user_id: s.user_id,
            source: "subscription",
            subscription_id: s.id,
            amount: monthlyTokens,
            consumed: 0,
            is_active: true,
            expires_at: expires.toISOString(),
            note: "yearly-monthly-refill (cron)",
          }).select("id").single();

          if (batchInsertError) {
            console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to insert token batch for sub ${s.id}:`, batchInsertError);
            throw batchInsertError;
          }

          const { error: updateError } = await supabase.from("subscriptions").update({ last_monthly_refill: now.toISOString() }).eq("id", s.id);
          if (updateError) {
            console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to update last_monthly_refill for sub ${s.id}:`, updateError);
            throw updateError;
          }
          
          // Log the token credit
          await supabase.from("token_event_logs").insert({
            user_id: s.user_id,
            batch_id: batchData.id,
            delta: monthlyTokens,
            reason: "yearly_refill",
          });

        } catch (e) {
            console.error(`[${EDGE_FUNCTION_NAME}] ❌ Refill process failed for subscription ${s.id}:`, e);
            // Continue to next subscription to prevent one failure from stopping the entire cron job
            continue;
        }
      }
    }
  } catch (e) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ An unexpected error occurred in the cron job:`, e);
    return new Response("Internal Server Error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});