import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe";

const EDGE_FUNCTION_NAME = "create_checkout_session";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const DOMAIN = Deno.env.get("PUBLIC_SITE_URL") ?? "http://localhost:3000";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);

function cors(origin = "*") {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
}

serve(async (req) => {
  const origin = req.headers.get("origin") || "*";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST")   return new Response("Method Not Allowed", { status: 405, headers: cors(origin) });

  try {
    // Parse minimal auth (adapt to your auth if different)
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return new Response("Unauthorized", { status: 401, headers: cors(origin) });

    const payload = JSON.parse(atob(token.split(".")[1] || "e30="));
    const user_id: string | undefined = payload.sub;
    const email: string | undefined = payload.email;
    if (!user_id || !email) return new Response("Unauthorized", { status: 401, headers: cors(origin) });

    // ensure user exists
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("stripe_customer_id")
      .eq("user_id", user_id)
      .single();
    if (userErr) return new Response("User not found", { status: 404, headers: cors(origin) });

    // ---- request body ----
    // plan_type: "one_time" | "daily" | "monthly" | "yearly"
    // plan_option: for one_time -> "tier1..tier5"; for subscriptions -> "basic|standard|premium|ultra|daily"
    const { plan_type, plan_option } = await req.json();
    if (!plan_type || !plan_option) {
      return new Response("Missing plan_type or plan_option", { status: 400, headers: cors(origin) });
    }

    // Look up price_id in the right table
    const isOneTime = plan_type === "one_time";
    const table = isOneTime ? "token_prices" : "subscription_prices";

    const { data: priceRow, error: priceErr } = await supabase
      .from(table)
      .select("price_id")
      .eq("plan_type", plan_type)
      .eq("plan_option", plan_option)
      .single();

    if (priceErr || !priceRow) {
      return new Response(`Price not found for ${table}.${plan_option}/${plan_type}`, { status: 404, headers: cors(origin) });
    }

    // Mode rules (aligned to your DB):
    // - one_time => Checkout "payment"
    // - daily/monthly/yearly => Checkout "subscription"
    const mode: "payment" | "subscription" = isOneTime ? "payment" : "subscription";

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: user?.stripe_customer_id || undefined,
      customer_email: user?.stripe_customer_id ? undefined : email,
      line_items: [{ price: priceRow.price_id, quantity: 1 }],
      success_url: `${DOMAIN}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${DOMAIN}/payment/cancelled`,
      metadata: { user_id, plan_type, plan_option },
      ...(mode === "subscription" && {
        subscription_data: { metadata: { user_id, plan_type, plan_option } },
      }),
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "content-type": "application/json", ...cors(origin) },
    });
  } catch (err) {
    console.error(`[${EDGE_FUNCTION_NAME}]`, err);
    return new Response("Internal Server Error", { status: 500, headers: cors() });
  }
});
