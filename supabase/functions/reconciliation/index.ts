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
    const { data: dbSubscriptions, error: dbError } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id, user_id, is_active");

    if (dbError) throw dbError;

    const issues = [];
    for (const dbSub of dbSubscriptions ?? []) {
      const stripeSub = await stripe.subscriptions.retrieve(dbSub.stripe_subscription_id);
      if (stripeSub.status !== "active" && dbSub.is_active) {
        issues.push(`Mismatch: Supabase subscription ${dbSub.stripe_subscription_id} is active, but Stripe status is ${stripeSub.status}.`);
      }
    }
    
    const { data: dbTokenBatches, error: tokenError } = await supabase
      .from("user_token_total")
      .select("user_id, total_available");
    if (tokenError) throw tokenError;

    // This is a placeholder for a more complete reconciliation job
    // It should also compare token amounts, payment issues, etc.
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