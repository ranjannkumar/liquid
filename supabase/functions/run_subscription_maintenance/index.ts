/**
 * Edge Function: monthly_subscription_tasks.ts
 *
 * 1. Marks expired token batches as inactive.
 * 2. Deactivates subscriptions whose billing period has ended.
 * 3. Updates each affected user’s `has_active_subscription` flag.
 * 4. For active yearly subscriptions, issues a monthly token refill once per month.
 * 5. All console logs are in English and prefixed with the function name for clarity.
 * 6. Critical failures send a Telegram notification.
 */

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "monthly_subscription_tasks";

// Required environment variables
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_KEY          = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY).`;
  console.error(errMsg);
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Missing required environment variables.`);
  }
  throw new Error("Missing required environment variables");
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Sends a notification message to Telegram.
 */
async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ TELEGRAM_BOT_KEY or TELEGRAM_CHAT_ID not set.`);
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Telegram API error: ${res.status} ${body}`);
    } else {
      console.log(`[${EDGE_FUNCTION_NAME}] 📢 Telegram notification sent.`);
    }
  } catch (err: unknown) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to send Telegram message: ${err}`);
  }
}

async function getMonthlyTokenAmount(plan_option: string): Promise<number> {
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens")
    .eq("plan_option", plan_option)
    .eq("plan_type", "yearly") // Assume 'yearly' holds the base monthly values
    .single();

  if (error || !data || typeof data.tokens !== "number") {
    const errText = `[${EDGE_FUNCTION_NAME}] ❌ Monthly token amount missing for plan: ${plan_option}`;
    console.error(errText);
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Token amount lookup failed for plan "${plan_option}"`);
    throw new Error(`Token amount missing for plan ${plan_option}`);
  }

  return data.tokens;
}

export const config = {
  runtime: "edge",
  permissions: "private", // Only invoked by a scheduler
};

serve(async (_req) => {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // 0. Mark expired token batches as inactive
  let expiredBatches;
  try {
    const { data, error } = await supabase
      .from("user_token_batches")
      .select("id")
      .eq("is_active", true)
      .lt("expires_at", now.toISOString());

    if (error) {
      throw error;
    }
    expiredBatches = data;
    console.log(`[${EDGE_FUNCTION_NAME}] 🔍 Found ${expiredBatches.length} expired token batch(es).`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Error fetching expired token batches: ${errorMessage}`;
    console.error(errMsg);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Failed to query expired token batches: ${errorMessage}`);
    }
    return new Response("Error fetching expired token batches", { status: 500 });
  }

  for (const batch of expiredBatches) {
    try {
      await supabase
        .from("user_token_batches")
        .update({ is_active: false })
        .eq("id", batch.id);
      console.log(`[${EDGE_FUNCTION_NAME}] ✅ Marked batch ${batch.id} as inactive.`);
    } catch (err: unknown) { // Resolved error: `err` is of type 'unknown'
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Failed to deactivate batch ${batch.id}: ${errorMessage}`);
      // Non-critical: continue with other batches
    }
  }

  // 1. Deactivate subscriptions that have expired
  let activeSubs;
  try {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("id, user_id, current_period_end")
      .eq("is_active", true);

    if (error) throw error;
    activeSubs = data;
    console.log(`[${EDGE_FUNCTION_NAME}] 🔍 Retrieved ${activeSubs.length} active subscription(s).`);
  } catch (err: unknown) { // Resolved error: `err` is of type 'unknown'
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Error fetching active subscriptions: ${errorMessage}`;
    console.error(errMsg);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Failed to query active subscriptions: ${errorMessage}`);
    }
    return new Response("Error fetching active subscriptions", { status: 500 });
  }

  let deactivatedCount = 0;
  const usersToUnset: Set<string> = new Set();

  for (const sub of activeSubs) {
    if (sub.current_period_end && new Date(sub.current_period_end) < now) {
      try {
        await supabase
          .from("subscriptions")
          .update({ is_active: false })
          .eq("id", sub.id);
        console.log(`[${EDGE_FUNCTION_NAME}] 🛑 Subscription expired for user ${sub.user_id} (sub_id: ${sub.id}).`);
        usersToUnset.add(sub.user_id);
        deactivatedCount += 1;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(
          `[${EDGE_FUNCTION_NAME}] ⚠️ Failed to deactivate subscription ${sub.id}: ${errorMessage}`
        );
        // Non-critical: continue processing other subscriptions
      }
    }
  }

  for (const userId of usersToUnset) {
    try {
      await supabase
        .from("users")
        .update({ has_active_subscription: false })
        .eq("user_id", userId);
      console.log(
        `[${EDGE_FUNCTION_NAME}] ✅ Cleared active subscription flag for user ${userId}.`
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${EDGE_FUNCTION_NAME}] ⚠️ Failed to update user ${userId} flag: ${errorMessage}`
      );
      // Non-critical
    }
  }

  // 2. Refill monthly tokens for active yearly subscriptions
  let yearlySubs;
  try {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("id, user_id, plan, last_monthly_refill")
      .eq("billing_cycle", "yearly")
      .eq("is_active", true);

    if (error) throw error;
    yearlySubs = data;
    console.log(
      `[${EDGE_FUNCTION_NAME}] 🔍 Retrieved ${yearlySubs.length} active yearly subscription(s).`
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Error fetching yearly subscriptions: ${errorMessage}`;
    console.error(errMsg);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Failed to query yearly subscriptions: ${errorMessage}`);
    }
    return new Response("Error fetching yearly subscriptions", { status: 500 });
  }

  let tokensRefilledCount = 0;

  for (const sub of yearlySubs) {
    const lastRefill = sub.last_monthly_refill
      ? new Date(sub.last_monthly_refill)
      : null;
    const alreadyRefilledThisMonth =
      lastRefill &&
      lastRefill.getFullYear() === currentYear &&
      lastRefill.getMonth() === currentMonth;

    if (alreadyRefilledThisMonth) {
      console.log(
        `[${EDGE_FUNCTION_NAME}] ℹ️ Subscription ${sub.id} already refilled for ${currentYear}-${currentMonth + 1}.`
      );
      continue;
    }

    let tokensMonthly: number;
    try {
      tokensMonthly = await getMonthlyTokenAmount(sub.plan);
      console.log(
        `[${EDGE_FUNCTION_NAME}] 🔢 Retrieved ${tokensMonthly} tokens/month for plan ${sub.plan}.`
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[${EDGE_FUNCTION_NAME}] ❌ Skipping refill for subscription ${sub.id} due to token lookup error: ${errorMessage}`
      );
      continue; // Skip this subscription but continue others
    }

    // Set expiration date for this new batch to one month from now
    const batchExpiresAt = new Date();
    batchExpiresAt.setMonth(batchExpiresAt.getMonth() + 1);

    try {
      await supabase.from("user_token_batches").insert({
        user_id: sub.user_id,
        source: "subscription",
        subscription_id: sub.id,
        amount: tokensMonthly,
        consumed: 0,
        expires_at: batchExpiresAt.toISOString(),
        is_active: true,
      });

      await supabase
        .from("subscriptions")
        .update({ last_monthly_refill: now.toISOString() })
        .eq("id", sub.id);

      console.log(
        `[${EDGE_FUNCTION_NAME}] 🎁 Issued ${tokensMonthly} tokens to user ${sub.user_id} (sub_id: ${sub.id}).`
      );
      tokensRefilledCount += 1;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errMsg = `[${EDGE_FUNCTION_NAME}] ⚠️ Failed to insert token batch or update subscription ${sub.id}: ${errorMessage}`;
      console.warn(errMsg);
      // Non-critical: continue with other subscriptions
    }
  }

  // 3. Return a summary response
  const resultMessage = `✅ ${deactivatedCount} subscription(s) deactivated, ${tokensRefilledCount} token batch(es) added.`;
  console.log(`[${EDGE_FUNCTION_NAME}] ${resultMessage}`);
  return new Response(resultMessage, { status: 200 });
});