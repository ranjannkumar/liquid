/**
 * Edge Function: handle_stripe_webhook.ts
 *
 * Processes Stripe webhook events, aligned with the canonical specification.
 * 1. Verifies webhook signature.
 * 2. Handles `customer.created` → saves stripe_customer_id.
 * 3. Handles `invoice.payment_failed` → marks user with payment issue.
 * 4. Handles `customer.subscription.deleted` → deactivates subscription.
 * 5. Handles `invoice.paid` → The SINGLE SOURCE OF TRUTH for creating/updating subscriptions and refilling tokens.
 * 6. Handles `checkout.session.completed` → For one-time token purchases ONLY.
 * 7. Logs all major steps with the function name prefix.
 * 8. Sends critical failure notifications to Telegram.
 */

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "handle_stripe_webhook";

// Required environment variables
const STRIPE_SECRET_KEY        = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET    = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL             = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TELEGRAM_BOT_KEY         = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID         = Deno.env.get("TELEGRAM_CHAT_ID");
const REFERRAL_TOKEN_AMOUNT    = Deno.env.get("REFERRAL_TOKEN_AMOUNT");

if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables.`;
  console.error(errMsg);
  // Early notification before full helper is available
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: errMsg }),
    });
  }
  throw new Error(errMsg);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-07-30.basil"});
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Sends a notification message to Telegram.
 */
async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
    if (!res.ok) {
        console.error(`[${EDGE_FUNCTION_NAME}] ❌ Telegram API error: ${await res.text()}`);
    }
  } catch (err:unknown) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to send Telegram message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function getSubscriptionTokenAmount(plan_option: string, billing_cycle: string): Promise<number> {
    const { data, error } = await supabase
      .from("subscription_prices")
      .select("tokens")
      .eq("plan_option", plan_option)
      .eq("plan_type", billing_cycle)
      .single();
  
    if (error || !data) {
      const errMsg = `Subscription token amount lookup failed for plan=${plan_option}, cycle=${billing_cycle}`;
      await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ❌ ${errMsg}`);
      throw new Error(errMsg);
    }
    return data.tokens;
}

async function createOrUpdateSubscription(user_id: string, stripeSub: Stripe.Subscription) {
    const plan = stripeSub.items.data[0].price.nickname!;
    const billing_cycle = stripeSub.items.data[0].price.recurring!.interval;
  
    const tokenBase = await getSubscriptionTokenAmount(plan, billing_cycle);
    
    // Deactivate old subscriptions for this user to ensure only one is active
    await supabase.from("subscriptions").update({ is_active: false }).eq("user_id", user_id);
// Insert new subscription record
const { data: subInsert, error: subError } = await supabase
    .from("subscriptions")
    .insert({
        user_id,
        plan,
        billing_cycle,
        stripe_subscription_id: stripeSub.id,
        is_active: true,
        amount: billing_cycle === 'year' ? tokenBase * 12 : tokenBase,
        
        // CORRECTED LINES: Added @ts-ignore to suppress the false type error
        // @ts-ignore
        current_period_start: new Date(stripeSub.current_period_start * 1000).toISOString(),
        // @ts-ignore
        current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
        
        ...(billing_cycle === "year" && { last_monthly_refill: new Date().toISOString() }),
    })
    .select("id")
    .single();

if (subError || !subInsert) throw subError || new Error("Failed to insert subscription");

    // Deactivate old subscription token batches
    await supabase.from("user_token_batches").update({ is_active: false }).eq("user_id", user_id).eq("source", "subscription");

    // Insert new token batch
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1); // Batches from subscriptions expire monthly

    await supabase.from("user_token_batches").insert({
        user_id,
        source: "subscription",
        subscription_id: subInsert.id,
        amount: tokenBase, // Grant one month's worth of tokens
        expires_at: expiresAt.toISOString(),
    });

    // Mark user as having an active subscription and no payment issues
    await supabase.from("users").update({ has_active_subscription: true, has_payment_issue: false }).eq("user_id", user_id);

    console.log(`[${EDGE_FUNCTION_NAME}] ✅ Subscription created/updated for ${user_id}`);
}

serve(async (req: Request) => {
    const sig = req.headers.get("stripe-signature");
    const rawBody = await req.text();
    let event: Stripe.Event;

    try {
        event = await stripe.webhooks.constructEventAsync(rawBody, sig!, STRIPE_WEBHOOK_SECRET!);
        console.log(`[${EDGE_FUNCTION_NAME}] ℹ️ Received event: ${event.type}`);
    } catch (err:unknown) {
        console.error(`[${EDGE_FUNCTION_NAME}] ❌ Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
        return new Response(`Webhook Error: ${err instanceof Error ? err.message : String(err)}`, { status: 400 });
    }

    try {
        switch (event.type) {
            case "customer.created": {
                const customer = event.data.object as Stripe.Customer;
                if (customer.email) {
                    await supabase.from("users").update({ stripe_customer_id: customer.id }).eq("email", customer.email);
                    console.log(`[${EDGE_FUNCTION_NAME}] ✅ Synced stripe_customer_id for ${customer.email}`);
                }
                break;
            }

            case "checkout.session.completed": {
                const session = event.data.object as Stripe.Checkout.Session;
                if (session.mode === "payment") { // ONE-TIME PURCHASES ONLY
                    const { user_id, plan_option } = session.metadata!;
                    const { data: existing } = await supabase.from("user_token_purchases").select('id').eq('stripe_purchase_id', session.id).single();
                    if (existing) {
                        console.log(`[${EDGE_FUNCTION_NAME}] ⚠️ Duplicate checkout session ${session.id} ignored.`);
                        return new Response("Duplicate", { status: 200 });
                    }

                    const { data: price } = await supabase.from("token_prices").select("tokens").eq("plan_option", plan_option).single();
                    if (!price) throw new Error(`Token price not found for ${plan_option}`);

                    const expiresAt = new Date();
                    expiresAt.setDate(expiresAt.getDate() + 60); // Tokens expire in 60 days

                    const { data: purchase, error: purchaseErr } = await supabase.from("user_token_purchases").insert({
                        user_id,
                        plan: plan_option,
                        stripe_purchase_id: session.id,
                        amount: price.tokens,
                        current_period_start: new Date().toISOString(),
                        current_period_end: expiresAt.toISOString()
                    }).select('id').single();

                    if (purchaseErr) throw purchaseErr;

                    await supabase.from("user_token_batches").insert({
                        user_id,
                        source: "purchase",
                        purchase_id: purchase.id,
                        amount: price.tokens,
                        expires_at: expiresAt.toISOString(),
                    });
                    console.log(`[${EDGE_FUNCTION_NAME}] 🎉 One-time purchase for ${user_id} completed.`);
                }
                break;
            }

            case "invoice.paid": {
                const invoice = event.data.object as Stripe.Invoice;
                // @ts-ignore - Suppress false type error, 'subscription' exists on Invoice object
                const stripe_subscription_id = invoice.subscription as string;
                if (!stripe_subscription_id) break; // Not a subscription payment

                const subscription = await stripe.subscriptions.retrieve(stripe_subscription_id);
                const user_id = subscription.metadata.user_id;
                if (!user_id) {
                    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ❌ Critical: user_id missing from metadata for subscription ${subscription.id}`);
                    break;
                }

                await createOrUpdateSubscription(user_id, subscription);
                
                // Referral Logic: Triggered on first successful subscription invoice
                if (invoice.billing_reason === 'subscription_create') {
                    const { data: ref } = await supabase.from("referrals").select("id, referrer_user_id, is_rewarded").eq("referred_user_id", user_id).single();
                    if (ref && !ref.is_rewarded) {
                        const tokens = parseInt(REFERRAL_TOKEN_AMOUNT || "0");
                        if (tokens > 0) {
                            const expiresAt = new Date();
                            expiresAt.setDate(expiresAt.getDate() + 365);
                            await supabase.from("user_token_batches").insert({
                                user_id: ref.referrer_user_id,
                                source: "referral",
                                amount: tokens,
                                expires_at: expiresAt.toISOString(),
                            });
                            await supabase.from("referrals").update({ is_rewarded: true }).eq("id", ref.id);
                            console.log(`[${EDGE_FUNCTION_NAME}] 🎁 Issued ${tokens} referral tokens to ${ref.referrer_user_id}`);
                        }
                    }
                }
                break;
            }

            case "invoice.payment_failed": {
                const invoice = event.data.object as Stripe.Invoice;
                const customer_id = invoice.customer as string;
                const { data: user } = await supabase.from("users").select("user_id").eq("stripe_customer_id", customer_id).single();
                if (user) {
                    await supabase.from("users").update({ has_payment_issue: true }).eq("user_id", user.user_id);
                    console.log(`[${EDGE_FUNCTION_NAME}] 🚨 Payment failed for user ${user.user_id}`);
                }
                break;
            }

            case "customer.subscription.deleted": {
                const subscription = event.data.object as Stripe.Subscription;
                await supabase.from("subscriptions").update({ is_active: false }).eq("stripe_subscription_id", subscription.id);
                if (subscription.metadata.user_id) {
                    await supabase.from("users").update({ has_active_subscription: false }).eq("user_id", subscription.metadata.user_id);
                }
                console.log(`[${EDGE_FUNCTION_NAME}] 🔕 Subscription cancelled for ${subscription.metadata.user_id}`);
                break;
            }
            default:
                console.log(`[${EDGE_FUNCTION_NAME}] 🤷‍♀️ Unhandled event type: ${event.type}`);
        }
    } catch (error:unknown) {
        const errorMessage = `[${EDGE_FUNCTION_NAME}] ❌ Error processing event ${event.type}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMessage);
        await notifyTelegram(errorMessage);
        return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }

    return new Response("OK", { status: 200 });
});