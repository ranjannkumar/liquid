// supabase/functions/create_checkout_session/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe";
import { decodeJwt } from "npm:jose"

const EDGE_FUNCTION_NAME = "create_checkout_session";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const DOMAIN = Deno.env.get("PUBLIC_SITE_URL") ?? "http://localhost:3000";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);

function getCorsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "3600"
  };
}

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    let payload: unknown;
    try {
        payload = decodeJwt(token);
    } catch (err: unknown) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: corsHeaders,
        });
    }

    if (typeof payload !== 'object' || payload === null || !('sub' in payload) || !('email' in payload)) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const user_id = (payload as { sub: string }).sub;
    const email = (payload as { email: string }).email;

    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("stripe_customer_id")
      .eq("user_id", user_id)
      .single();
    if (userErr) return new Response("User not found", { status: 404, headers: corsHeaders });

    const { plan_type, plan_option } = await req.json();
    if (!plan_type || !plan_option) {
      return new Response("Missing plan_type or plan_option", { status: 400, headers: corsHeaders });
    }

    const isOneTime = plan_type === "one_time";
    const table = isOneTime ? "token_prices" : "subscription_prices";

    const { data: priceRow, error: priceErr } = await supabase
      .from(table)
      .select("price_id")
      .eq("plan_type", plan_type)
      .eq("plan_option", plan_option)
      .single();

    if (priceErr || !priceRow) {
      return new Response(`Price not found for ${table}.${plan_option}/${plan_type}`, { status: 404, headers: corsHeaders });
    }

    const mode: "payment" | "subscription" = isOneTime ? "payment" : "subscription";
    
    // Check if we need to create a new Stripe customer
    const stripeCustomerId = user?.stripe_customer_id || undefined;
    if (!stripeCustomerId) {
      console.log(`[${EDGE_FUNCTION_NAME}] No existing Stripe customer found. A new one will be created.`);
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: stripeCustomerId,
      customer_email: stripeCustomerId ? undefined : email,
      line_items: [{ price: priceRow.price_id, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${DOMAIN}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/payment/cancelled`,
      metadata: { user_id, plan_type, plan_option },
      ...(mode === "subscription" && {
        subscription_data: { metadata: { user_id, plan_type, plan_option } },
      }),
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(`[${EDGE_FUNCTION_NAME}]`, err);
    return new Response("Internal Server Error", { status: 500, headers: getCorsHeaders(origin) });
  }
});