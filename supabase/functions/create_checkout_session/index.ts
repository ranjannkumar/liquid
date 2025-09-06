/**
 * Edge Function: create_checkout_session.ts
 *
 * 1. Handles CORS preflight.
 * 2. Authenticates user via JWT using a verified library.
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
import { decodeJwt } from "npm:jose";

const EDGE_FUNCTION_NAME = "create_checkout_session";

// Environment variables
const STRIPE_SECRET_KEY         = Deno.env.get("STRIPE_SECRET_KEY");
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TELEGRAM_BOT_KEY          = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID");
const DOMAIN                    = Deno.env.get("DOMAIN");

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DOMAIN) {
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables.`;
  console.error(errMsg);
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Missing required environment variables.`);
  }
  throw new Error(errMsg);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-07-30.basil" });
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function getCorsHeaders(origin: string): HeadersInit {
    const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:8000",
        DOMAIN,
    ];
    if (allowedOrigins.includes(origin)) {
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        };
    }
    return {}; // Return empty headers if origin not allowed
}


async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (err: unknown) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to send Telegram message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    // 1. Authenticate via JWT
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const payload = decodeJwt(token);
    const user_id = payload.sub;
    const email = payload.email as string;

    if (!user_id || !email) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }
    console.log(`[${EDGE_FUNCTION_NAME}] 🔑 Authenticated user: ${user_id}`);

    // 2. Confirm user exists
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, stripe_customer_id")
      .eq("user_id", user_id)
      .single();
    if (userError || !user) {
      return new Response("User not found", { status: 404, headers: corsHeaders });
    }

    // 3. Parse request body
    const { plan_type, plan_option } = await req.json();
    if (!plan_type || !plan_option) {
      return new Response("Missing plan_type or plan_option", { status: 400, headers: corsHeaders });
    }

    // 4. Look up price_id
    const isOneTime = plan_type === "tokens";
    const table = isOneTime ? "token_prices" : "subscription_prices";
    const { data: priceRow, error: priceError } = await supabase
      .from(table)
      .select("price_id")
      .eq("plan_type", plan_type)
      .eq("plan_option", plan_option)
      .single();

    if (priceError || !priceRow) {
      return new Response("Price not found", { status: 404, headers: corsHeaders });
    }

    // 5. Create Stripe Checkout Session
    const stripeMode = isOneTime || plan_type === "daily" ? "payment" : "subscription";
    const session = await stripe.checkout.sessions.create({
      mode: stripeMode,
      payment_method_types: ["card"],
      customer: user.stripe_customer_id || undefined, // Use existing customer if available
      customer_email: user.stripe_customer_id ? undefined : email, // Only provide email for new customers
      line_items: [{ price: priceRow.price_id, quantity: 1 }],
      success_url: `${DOMAIN}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/payment/cancelled`,
      metadata: { user_id, plan_type, plan_option },
      ...(stripeMode === "subscription" && {
        subscription_data: { metadata: { user_id, plan_type, plan_option } },
      }),
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Unexpected error: ${errorMessage}`);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Unexpected error: ${errorMessage}`);
    }
    return new Response("Internal Server Error", { status: 500, headers: getCorsHeaders(origin) });
  }
});