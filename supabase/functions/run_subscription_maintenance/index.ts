/**
 * Cron worker that:
 *  1) Marks expired batches inactive.
 *  2) Deactivates subscriptions whose current_period_end < now.
 *  3) Yearly refill safety-net (idempotent by month) — useful if an invoice webhook was missed.
 *
 * Spec: “Background workers (cronjobs, expiry sweeps, yearly→monthly refill).” :contentReference[oaicite:13]{index=13}
 */

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

  // 0) expire batches
  const { data: expired } = await supabase
    .from("user_token_batches")
    .select("id")
    .eq("is_active", true)
    .lt("expires_at", now.toISOString());
  for (const b of expired ?? []) {
    await supabase.from("user_token_batches").update({ is_active: false }).eq("id", b.id);
  }

  // 1) subscriptions past period end
  const { data: activeSubs } = await supabase
    .from("subscriptions")
    .select("id, user_id, current_period_end")
    .eq("is_active", true);
  for (const s of activeSubs ?? []) {
    if (s.current_period_end && new Date(s.current_period_end) < now) {
      await supabase.from("subscriptions").update({ is_active: false }).eq("id", s.id);
      await supabase.from("users").update({ has_active_subscription: false }).eq("user_id", s.user_id);
    }
  }

  // 2) Yearly safety-net monthly refill (idempotent by month)
  const { data: yearly } = await supabase
    .from("subscriptions")
    .select("id, user_id, plan, last_monthly_refill")
    .eq("billing_cycle", "yearly")
    .eq("is_active", true);

  for (const s of yearly ?? []) {
    const last = s.last_monthly_refill ? new Date(s.last_monthly_refill) : null;
    const already = last && last.getMonth() === thisMonth && last.getFullYear() === thisYear;
    if (already) continue;

    // find plan tokens for monthly slice
    const { data: tokenRow } = await supabase
      .from("subscription_prices")
      .select("tokens")
      .eq("price_id", s.plan) // we store price_id in subscriptions.plan
      .eq("plan_type", "yearly")
      .maybeSingle();
    if (!tokenRow) continue;

    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);
    await supabase.from("user_token_batches").insert({
      user_id: s.user_id,
      source: "subscription",
      subscription_id: s.id,
      amount: tokenRow.tokens,
      consumed: 0,
      is_active: true,
      expires_at: expires.toISOString(),
      note: "yearly-monthly-refill (cron)",
    });
    await supabase.from("subscriptions").update({ last_monthly_refill: now.toISOString() }).eq("id", s.id);
  }

  return new Response("ok", { status: 200 });
});
