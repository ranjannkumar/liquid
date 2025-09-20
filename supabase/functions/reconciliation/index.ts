// supabase/functions/reconciliation/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe";

const EDGE_FUNCTION_NAME = "reconciliation";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);

serve(async () => {
  try {
    const issues = [];
    const now = new Date();

    // 1. Compare Stripe Subscriptions vs DB Subscriptions
    const { data: dbSubscriptions, error: dbError } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id, user_id, is_active, plan_option");
    if (dbError) throw dbError;

    const stripeSubscriptions = await stripe.subscriptions.list({
      limit: 100 // Fetch a reasonable number for reconciliation
    });
    
    // Check for mismatches
    for (const dbSub of dbSubscriptions ?? []) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(dbSub.stripe_subscription_id);
        // Mismatched status
        if (stripeSub.status !== "active" && dbSub.is_active) {
          issues.push(`Mismatch: Supabase sub ${dbSub.stripe_subscription_id} is active, but Stripe status is ${stripeSub.status}.`);
        }
        
        // Mismatched plan
        const stripePrice = stripeSub.items.data[0].price;
        const { data: priceRow, error: priceError } = await supabase
          .from("subscription_prices")
          .select("plan_option")
          .eq("price_id", stripePrice.id)
          .maybeSingle();
        if (priceError || !priceRow || priceRow.plan_option !== dbSub.plan_option) {
          issues.push(`Mismatch: Supabase sub ${dbSub.stripe_subscription_id} has plan ${dbSub.plan_option}, but Stripe price ID ${stripePrice.id} does not match.`);
        }
      } catch (e) {
        issues.push(`Orphan: Supabase sub ${dbSub.stripe_subscription_id} exists, but not found in Stripe.`)
      }
    }

    // 2. Compare User Token Totals (a placeholder for now)
    const { data: dbTokenTotals, error: tokenError } = await supabase
      .from("user_token_total")
      .select("user_id, total_available");
    if (tokenError) throw tokenError;

    // TODO: A more complete reconciliation would fetch Stripe invoices and compare token credits.
    // This is a placeholder for that logic.

    if (issues.length > 0) {
      console.warn(`[${EDGE_FUNCTION_NAME}] Reconciliation found issues:`, issues);
      return new Response(JSON.stringify({ status: "warning", issues: issues }), { status: 200 });
    } else {
      console.log(`[${EDGE_FUNCTION_NAME}] Reconciliation completed. No issues found.`);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }

  } catch (err) {
    console.error(`[${EDGE_FUNCTION_NAME}] Error during reconciliation:`, err);
    return new Response("Internal Server Error", { status: 500 });
  }
});