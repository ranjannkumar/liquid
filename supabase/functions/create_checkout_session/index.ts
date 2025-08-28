/**
 * Edge Function: create_checkout_session.ts
 *
 * 1. Handles CORS preflight.
 * 2. Authenticates user via JWT.
 * 3. Verifies user exists in Supabase.
 * 4. Validates request body (`plan_type`, `plan_option`).
 * 5. Checks for conflicting active subscription (for non-token plans).
 * 6. Retrieves the appropriate Stripe `price_id` from Supabase.
 * 7. Creates a Stripe Checkout Session.
 * 8. Returns the session URL in JSON.
 * 9. All console logs include the function name identifier for clarity.
 * 10. Critical failures send a notification to Telegram.
 */

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "create_checkout_session";

// Required environment variables
const STRIPE_SECRET_KEY           = Deno.env.get("STRIPE_SECRET_KEY");
const SUPABASE_URL                = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TELEGRAM_BOT_KEY            = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID            = Deno.env.get("TELEGRAM_CHAT_ID");
const DOMAIN                      = Deno.env.get("DOMAIN"); // New variable

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DOMAIN) {
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables (STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or DOMAIN).`;
  console.error(errMsg);
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Missing required environment variables.`);
  }
  throw new Error("Missing required environment variables");
}

const allowedOrigins = new Set([
  "https://localhost",
  DOMAIN, // Add the domain to the allowed origins
]);

function getCorsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "3600"
  };
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-07-30.basil" });
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
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to send Telegram message: ${errorMessage}`);
  }
}

export const config = {
  runtime: "edge",
};

serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const corsHeaders = getCorsHeaders(origin);

   // 0. CORS preflight handler
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  const domain = Deno.env.get("DOMAIN")!;

 

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    // 1. Authenticate via JWT
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    let payload: unknown;
    try {
      payload = JSON.parse(atob(token.split(".")[1]));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Failed to decode JWT: ${errorMessage}`);
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (typeof payload !== 'object' || payload === null || !('sub' in payload) || !('email' in payload)) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ JWT missing sub or email.`);
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    
    const user_id = (payload as { sub: string, email: string }).sub;
    const email = (payload as { sub: string, email: string }).email;
    
    if (!user_id || !email) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ JWT missing sub or email.`);
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    console.log(`[${EDGE_FUNCTION_NAME}] 🔑 Authenticated user: ${user_id}`);

    // 2. Confirm that user exists
    let userExists: { id: string } | null = null;
    try {
      const { data, error } = await supabase
        .from("users")
        .select("id")
        .eq("user_id", user_id)
        .maybeSingle();
      if (error) {
        throw error;
      }
      userExists = data;
      if (!userExists) {
        console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ User not found: ${user_id}`);
        return new Response("User not found", {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      console.log(`[${EDGE_FUNCTION_NAME}] ✅ User exists in database.`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error verifying user existence: ${errorMessage}`);
      if (err instanceof Error) {
        await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error verifying user: ${errorMessage}`);
      }
      return new Response("Internal server error", {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // 3. Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Failed to parse JSON body: ${errorMessage}`);
      return new Response("Invalid JSON payload", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    if (typeof body !== 'object' || body === null || !('plan_type' in body) || !('plan_option' in body)) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Missing plan_type or plan_option.`);
      return new Response("Missing plan_type or plan_option", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    
    const { plan_type, plan_option } = body as { plan_type: string, plan_option: string };
    
    console.log(`[${EDGE_FUNCTION_NAME}] 📥 Requested plan_type="${plan_type}", plan_option="${plan_option}"`);

    const isOneTime = plan_type === "tokens";
    const table = isOneTime ? "token_prices" : "subscription_prices";

    // 4. Check for active subscription conflicts (only for non-token plans)
    if (!isOneTime) {
      try {
        const { data: currentSub, error: currentSubError } = await supabase
          .from("subscriptions")
          .select("plan, billing_cycle")
          .eq("user_id", user_id)
          .eq("is_active", true)
          .maybeSingle();
        if (currentSubError) throw currentSubError;

        if (currentSub) {
          const currentPlan = currentSub.plan;
          const currentCycle = currentSub.billing_cycle;
          const planOrder = ["daily", "basic", "standard", "premium", "ultra"];
          const currentIndex = planOrder.indexOf(currentPlan);
          const newIndex = planOrder.indexOf(plan_option);

          // Same plan & cycle
          if (currentPlan === plan_option && currentCycle === plan_type) {
            console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ User ${user_id} already on plan "${plan_option}" (${plan_type}).`);
            return new Response("You already have this plan active", {
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }

          // Downgrade attempt
          if (newIndex < currentIndex) {
            console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Downgrade not allowed for user ${user_id}.`);
            return new Response("Cannot downgrade without canceling current plan", {
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }

          // “Daily” plan conflict
          if (plan_type === "daily") {
            console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Cannot subscribe to daily plan while having another active plan.`);
            return new Response("Cannot subscribe to the daily plan while another plan is active", {
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error checking current subscription: ${errorMessage}`);
        if (err instanceof Error) {
          await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error checking current subscription: ${errorMessage}`);
        }
        return new Response("Internal server error", {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // 5. Lookup price_id in Supabase
    let priceRow: { price_id: string } | null = null;
    try {
      const { data, error } = await supabase
        .from(table)
        .select("price_id")
        .eq("plan_type", plan_type)
        .eq("plan_option", plan_option)
        .single();
      if (error) throw error;
      priceRow = data;
      if (!priceRow) {
        console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Price not found for ${plan_type}/${plan_option}.`);
        return new Response("Price not found", {
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      console.log(`[${EDGE_FUNCTION_NAME}] ✅ Found price_id=${priceRow.price_id} in table "${table}".`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error fetching price row: ${errorMessage}`);
      if (err instanceof Error) {
        await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error fetching price row: ${errorMessage}`);
      }
      return new Response("Internal server error", {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // 6. Determine Stripe mode (payment vs. subscription)
    const stripeMode = isOneTime || plan_type === "daily" ? "payment" : "subscription";
    console.log(`[${EDGE_FUNCTION_NAME}] 🔀 Stripe mode set to "${stripeMode}".`);

    // 7. Create Stripe Checkout Session
    let session: Stripe.Checkout.Session;
    try {
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: stripeMode,
        payment_method_types: ["card"],
        customer_email: email,
        line_items: [{ price: priceRow.price_id, quantity: 1 }],
        success_url: `${domain}/success`,
        cancel_url: `${domain}/cancel`,
        metadata: { user_id, plan_type, plan_option },
      };
      if (stripeMode === "subscription") {
        sessionParams.subscription_data = {
          metadata: { user_id, plan_type, plan_option },
        };
      }

      session = await stripe.checkout.sessions.create(sessionParams);
      console.log(`[${EDGE_FUNCTION_NAME}] ✅ Stripe session created (id=${session.id}).`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error creating Stripe session: ${errorMessage}`);
      if (err instanceof Error) {
        await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Stripe session creation error: ${errorMessage}`);
      }
      return new Response("Internal server error", {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // 8. Return session URL
    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (err: unknown) {
    // Catch-all for unexpected errors
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Unexpected error: ${errorMessage}`);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Unexpected error: ${errorMessage}`);
    }
    return new Response("Internal server error", {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
});