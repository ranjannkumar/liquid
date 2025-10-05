// supabase/functions/create_checkout_session/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe";
import { decodeJwt } from "npm:jose";

const EDGE_FUNCTION_NAME = "create_checkout_session";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const DOMAIN = Deno.env.get("PUBLIC_SITE_URL") ?? "http://localhost:3000";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// ✅ Set apiVersion to avoid subtle type/runtime mismatches
const stripe = new Stripe(STRIPE_SECRET_KEY, {  apiVersion: "2025-07-30.basil"  });

function getCorsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "3600",
  };
}

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    let payload: unknown;
    try {
      payload = decodeJwt(token);
    } catch (_e) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    if (typeof payload !== "object" || payload === null || !("sub" in payload) || !("email" in payload)) {
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

    // Active subscription snapshot
    const { data: activeSub } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id, plan") // plan: Stripe price id stored locally
      .eq("user_id", user_id)
      .eq("is_active", true)
      .maybeSingle();

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
      return new Response(
        `Price not found for ${table}.${plan_option}/${plan_type}`,
        { status: 404, headers: corsHeaders },
      );
    }

    const mode: "payment" | "subscription" = isOneTime ? "payment" : "subscription";

    const stripeCustomerId = user?.stripe_customer_id || undefined;
    if (!stripeCustomerId) {
      console.log(`[${EDGE_FUNCTION_NAME}] No existing Stripe customer found. A new one will be created by Checkout if needed.`);
    }

    let subscription_data:
      | Stripe.Checkout.SessionCreateParams.SubscriptionData
      | undefined = undefined;
    let line_items_for_session: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

    const existingStripeSubId: string | undefined = activeSub?.stripe_subscription_id;
    const isUpgrade =
      mode === "subscription" && !!existingStripeSubId && activeSub?.plan !== priceRow.price_id;
    const isNewSubscription = mode === "subscription" && !isUpgrade;

    if (isUpgrade) {
      // ────────────────────────────────────────────────────────────────────────────
      // UPGRADE BRANCH (Subscriptions API)
      // Stripe Checkout subscription_data **cannot** change existing subscription items.
      // Use Subscriptions API to update items with proration.
      // ────────────────────────────────────────────────────────────────────────────

      // Expand items to fetch the item id we must replace
      const stripeSub = await stripe.subscriptions.retrieve(existingStripeSubId, {
        expand: ["items.data.price"],
      });
      const subItem = stripeSub.items.data[0];
      if (!subItem) {
        console.error(`[${EDGE_FUNCTION_NAME}] No subscription item on ${existingStripeSubId}`);
        return new Response("Invalid subscription data", { status: 500, headers: corsHeaders });
      }

      const updated = await stripe.subscriptions.update(existingStripeSubId, {
        items: [
          {
            id: subItem.id,
            price: priceRow.price_id,
            quantity: 1,
          },
        ],
        proration_behavior: "create_prorations",
        billing_cycle_anchor: "now",       // start the new yearly period now
        cancel_at_period_end: false,
        metadata: { user_id, plan_type, plan_option, reason: "mid-cycle-upgrade" },
      });

      // Optionally fetch the latest invoice for UI info (amount due, hosted url, etc.)
      // const latestInvId = typeof updated.latest_invoice === "string" ? updated.latest_invoice : updated.latest_invoice?.id;

      // Return a simple OK; payment will be attempted automatically against default PM.
      // Your webhook on `invoice.paid` should perform token crediting.
      return new Response(
        JSON.stringify({
          upgraded: true,
          subscription_id: updated.id,
          // latest_invoice_id: latestInvId ?? null,
          message: "Subscription upgraded with proration. Tokens will be credited on invoice.paid.",
        }),
        { status: 200, headers: { "content-type": "application/json", ...corsHeaders } },
      );
    }

    // NEW SUBSCRIPTION (Checkout) or ONE-TIME PAYMENT (Checkout)
    if (isNewSubscription) {
      line_items_for_session = [{ price: priceRow.price_id, quantity: 1 }];
      // NOTE: subscription_data **must not** include 'items' here — Checkout handles it from line_items.
      subscription_data = {
        metadata: { user_id, plan_type, plan_option },
      };
    } else if (isOneTime) {
      line_items_for_session = [{ price: priceRow.price_id, quantity: 1 }];
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: stripeCustomerId,
      customer_email: stripeCustomerId ? undefined : email,
      line_items: line_items_for_session.length > 0 ? line_items_for_session : undefined,
      allow_promotion_codes: true,
      success_url: `${DOMAIN}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/payment/cancelled`,
      metadata: { user_id, plan_type, plan_option },
      ...(subscription_data && { subscription_data }),
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(`[${EDGE_FUNCTION_NAME}]`, err);
    return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
  }
});