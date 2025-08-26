/**
 * Edge Function: cancel_subscription.ts
 *
 * Cancels a user's active Stripe subscription at period end.
 * 1. Handles CORS preflight.
 * 2. Authenticates user via JWT.
 * 3. Finds the most recent active subscription for the user in Supabase.
 * 4. Calls Stripe to set `cancel_at_period_end: true`.
 * 5. Logs each step with function name prefix.
 * 6. Sends critical failure notifications to Telegram.
 */

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "cancel_subscription";

// Required environment variables
const STRIPE_SECRET_KEY           = Deno.env.get("STRIPE_SECRET_KEY");
const SUPABASE_URL                = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TELEGRAM_BOT_KEY            = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID            = Deno.env.get("TELEGRAM_CHAT_ID");

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables (STRIPE_SECRET_KEY, SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY).`;
  console.error(errMsg);
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Missing required environment variables.`);
  }
  throw new Error("Missing required environment variables");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const allowedOrigins = new Set([
  "https://localhost",
]);

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
  } catch (err) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to send Telegram message: ${err}`);
  }
}

export const config = {
  runtime: "edge",
  permissions: "protected", // JWT required
};

serve(async (req: Request) => {

  const origin = req.headers.get("origin") || "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "3600"
  };

  
  // 1. CORS preflight handler
  if (req.method === "OPTIONS") {
    console.log(`[${EDGE_FUNCTION_NAME}] 🔄 CORS preflight request received.`);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== "POST") {
    console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Received non-POST request: ${req.method}`);
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    // 2. Authenticate via JWT
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    let payload: any;
    try {
      payload = JSON.parse(atob(token.split(".")[1]));
    } catch (err) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Failed to decode JWT: ${err}`);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const user_id = payload.sub;
    if (!user_id) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ JWT missing sub claim.`);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    console.log(`[${EDGE_FUNCTION_NAME}] 🔑 Authenticated user: ${user_id}`);

    // 3. Find active subscription in Supabase
    let activeSubId: string | null = null;
    try {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("stripe_subscription_id")
        .eq("user_id", user_id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (error) throw error;
      if (!data?.stripe_subscription_id) {
        console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Active subscription not found for user: ${user_id}`);
        return new Response(JSON.stringify({ error: "Active subscription not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }
      activeSubId = data.stripe_subscription_id;
      console.log(`[${EDGE_FUNCTION_NAME}] ✅ Found active subscription ID: ${activeSubId} for user: ${user_id}`);
    } catch (err: any) {
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error fetching active subscription: ${err.message}`);
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error fetching active subscription for user=${user_id}: ${err.message}`);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    // 4. Cancel at period end in Stripe
    try {
      await stripe.subscriptions.update(activeSubId, { cancel_at_period_end: true });
      console.log(`[${EDGE_FUNCTION_NAME}] 🎬 Scheduled cancellation for subscription ID: ${activeSubId}`);
    } catch (err: any) {
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error scheduling cancellation: ${err.message}`);
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error scheduling cancellation for subscription=${activeSubId}: ${err.message}`);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    // 5. Return success response
    return new Response(JSON.stringify({ message: "Subscription cancellation scheduled" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Unexpected error: ${err.message}`);
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Unexpected error: ${err.message}`);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
