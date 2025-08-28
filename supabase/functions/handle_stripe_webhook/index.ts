/**
 * Edge Function: handle_stripe_webhook.ts
 *
 * Processes Stripe webhook events:
 * 1. Verifies webhook signature and parses event.
 * 2. Handles `invoice.payment_failed` → marks user payment issue.
 * 3. Handles `customer.subscription.deleted` → deactivates subscription and flags payment issue.
 * 4. Handles `invoice.paid` & `customer.subscription.updated` → creates or updates subscription, refilling tokens.
 * 5. Handles `checkout.session.completed` → finalizes one-time token purchases or new subscriptions.
 * 6. Logs all major steps with the function name prefix.
 * 7. Sends critical failure notifications to Telegram.
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
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY).`;
  console.error(errMsg);
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Missing required environment variables.`);
  }
  throw new Error("Missing required environment variables");
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

async function getSubscriptionTokenAmount(plan_option: string, billing_cycle: string): Promise<number> {
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens")
    .eq("plan_option", plan_option)
    .eq("plan_type", billing_cycle)
    .single();

  if (error || !data || typeof data.tokens !== "number") {
    const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Invalid or missing token amount in subscription_prices for plan_option=${plan_option}, billing_cycle=${billing_cycle}`;
    console.error(errMsg);
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Subscription token amount lookup failed: ${errMsg}`);
    throw new Error("Invalid or missing token amount in subscription_prices");
  }
  return data.tokens;
}

async function getOneTimeTokenAmount(plan_option: string): Promise<number> {
  const { data, error } = await supabase
    .from("token_prices")
    .select("tokens")
    .eq("plan_option", plan_option)
    .eq("plan_type", "one_time")
    .single();

  if (error || !data || typeof data.tokens !== "number") {
    const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Invalid or missing token amount in token_prices for plan_option=${plan_option}`;
    console.error(errMsg);
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ One-time token amount lookup failed: ${errMsg}`);
    throw new Error("Invalid or missing token amount in token_prices");
  }
  return data.tokens;
}

async function updateUserPaymentStatus(user_id: string, hasIssue: boolean) {
  try {
    await supabase.from("users").update({ has_payment_issue: hasIssue }).eq("user_id", user_id);
    console.log(`[${EDGE_FUNCTION_NAME}] 📝 Updated payment status for ${user_id} to hasIssue=${hasIssue}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error updating payment status for ${user_id}: ${errorMessage}`);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error updating payment status for ${user_id}: ${errorMessage}`);
    }
  }
}

async function createOrUpdateSubscription(params: {
  user_id: string;
  plan: string;
  billing_cycle: string;
  stripe_subscription_id: string | null;
}) {
  const { user_id, plan, billing_cycle, stripe_subscription_id } = params;

  if (!user_id || !plan || !billing_cycle) {
    const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required subscription data`;
    console.error(errMsg);
    await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Missing required subscription data`);
    throw new Error("Missing required subscription data");
  }

  const now = new Date();
  const end = new Date(now);
  if (billing_cycle === "daily") end.setDate(end.getDate() + 1);
  else if (billing_cycle === "monthly") end.setMonth(end.getMonth() + 1);
  else if (billing_cycle === "yearly") end.setFullYear(end.getFullYear() + 1);

  let tokenBase: number;
  try {
    tokenBase = await getSubscriptionTokenAmount(plan, billing_cycle);
    console.log(`[${EDGE_FUNCTION_NAME}] 🔢 Retrieved base tokens=${tokenBase} for plan=${plan}, billing_cycle=${billing_cycle}`);
  } catch (_err: unknown) {
    // getSubscriptionTokenAmount already notified
    throw new Error("Token lookup failed");
  }

  const multiplier = billing_cycle === "yearly" ? 12 : 1;

  // Calculate remaining tokens from previous active batches
  let remainingOld = 0;
  try {
    const { data: previousBatches, error: batchError } = await supabase
      .from("user_token_batches")
      .select("amount, consumed")
      .eq("user_id", user_id)
      .eq("source", "subscription")
      .eq("is_active", true);

    if (!batchError && previousBatches) {
      remainingOld = previousBatches.reduce((acc, b) => acc + (b.amount - b.consumed), 0);
      console.log(`[${EDGE_FUNCTION_NAME}] 🔍 Remaining tokens from old batches: ${remainingOld}`);
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Error fetching previous batches for ${user_id}: ${errorMessage}`);
  }

  const tokensTotal = tokenBase * multiplier;

  // Deactivate all existing subscriptions for this user
  try {
    await supabase.from("subscriptions").update({ is_active: false }).eq("user_id", user_id);
    console.log(`[${EDGE_FUNCTION_NAME}] ✅ Deactivated previous subscriptions for ${user_id}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error deactivating previous subscriptions for ${user_id}: ${errorMessage}`);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error deactivating subscriptions for ${user_id}: ${errorMessage}`);
    }
    throw new Error("Subscription deactivate failed");
  }

  // Insert new subscription record
  let subInsertId: string;
  try {
    const { data: subInsert, error: subError } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan,
        billing_cycle,
        stripe_subscription_id,
        is_active: true,
        amount: tokensTotal,
        current_period_start: now.toISOString(),
        current_period_end: end.toISOString(),
        ...(billing_cycle === "yearly" && { last_monthly_refill: now.toISOString() }),
      })
      .select("id")
      .single();

    if (subError || !subInsert) {
      throw subError ?? new Error("Insert error in subscriptions");
    }
    subInsertId = subInsert.id;
    console.log(`[${EDGE_FUNCTION_NAME}] 🎉 Created new subscription (id=${subInsertId}) for ${user_id}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error inserting subscription for ${user_id}: ${errorMessage}`);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error inserting subscription for ${user_id}: ${errorMessage}`);
    }
    throw new Error("Subscription insert failed");
  }

  // Deactivate old token batches
  try {
    await supabase
      .from("user_token_batches")
      .update({ is_active: false })
      .eq("user_id", user_id)
      .eq("source", "subscription");
    console.log(`[${EDGE_FUNCTION_NAME}] 🔄 Deactivated old token batches for ${user_id}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Error deactivating old batches for ${user_id}: ${errorMessage}`);
  }

  // Insert new token batch with base + remainingOld
  try {
    const expiresAt =
      billing_cycle === "daily"
        ? end.toISOString()
        : (() => {
            const temp = new Date(now);
            temp.setMonth(temp.getMonth() + 1);
            return temp.toISOString();
          })();

    const batchAmount = tokenBase + remainingOld;
    await supabase.from("user_token_batches").insert({
      user_id,
      source: "subscription",
      subscription_id: subInsertId,
      amount: batchAmount,
      consumed: 0,
      is_active: true,
      expires_at: expiresAt,
    });
    console.log(`[${EDGE_FUNCTION_NAME}] 🎁 Inserted token batch (amount=${batchAmount}) for ${user_id}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error inserting new token batch for ${user_id}: ${errorMessage}`);
    if (err instanceof Error) {
      await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error inserting token batch for ${user_id}: ${errorMessage}`);
    }
    throw new Error("Token batch insert failed");
  }

  // Mark user as having an active subscription
  try {
    await supabase
      .from("users")
      .update({ has_active_subscription: true })
      .eq("user_id", user_id);
    console.log(`[${EDGE_FUNCTION_NAME}] ✅ Updated user.has_active_subscription=true for ${user_id}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Error updating user flag for ${user_id}: ${errorMessage}`);
  }
}

export const config = {
  runtime: "edge",
  permissions: "public",
};

serve(async (req: Request) => {
  let rawBody: string;
  let sig: string | null;

  // 1. Read raw body for signature verification
  try {
    sig = req.headers.get("stripe-signature");
    rawBody = await req.text();
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error reading request body: ${errorMessage}`);
    return new Response("Bad Request", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig!, STRIPE_WEBHOOK_SECRET!);
    console.log(`[${EDGE_FUNCTION_NAME}] ✅ Stripe event received: ${event.type}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Webhook signature verification failed: ${errorMessage}`);
    return new Response("Webhook signature error", { status: 400 });
  }

  // 2. Handle invoice.payment_failed
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    let user_id = invoice.metadata?.user_id as string | undefined;

    if (!user_id && 'subscription' in invoice && typeof invoice.subscription === 'string') {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
        user_id = stripeSub.metadata?.user_id!;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to retrieve subscription metadata: ${errorMessage}`);
      }
    }

    if (user_id) {
      await updateUserPaymentStatus(user_id, true);
      console.log(`[${EDGE_FUNCTION_NAME}] 🚨 Invoice payment failed for user: ${user_id}`);
    } else {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ user_id not found in invoice metadata or subscription`);
    }

    return new Response("Invoice payment failed processed", { status: 200 });
  }

  // 3. Handle customer.subscription.deleted
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const user_id = subscription.metadata?.user_id as string | undefined;
    if (!user_id) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Missing user_id in subscription metadata for deletion`);
      return new Response("Missing user_id", { status: 400 });
    }

    try {
      await supabase.from("subscriptions").update({ is_active: false }).eq("user_id", user_id);
      await supabase
        .from("users")
        .update({ has_active_subscription: false, has_payment_issue: true })
        .eq("user_id", user_id);
      console.log(`[${EDGE_FUNCTION_NAME}] 🔕 Subscription cancelled for ${user_id}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error updating subscription/user flags for ${user_id}: ${errorMessage}`);
      if (err instanceof Error) {
        await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error updating on subscription deletion for ${user_id}: ${errorMessage}`);
      }
    }

    return new Response("Subscription cancelled", { status: 200 });
  }

  // 4. Handle invoice.paid & customer.subscription.updated
  if (["invoice.paid", "customer.subscription.updated"].includes(event.type)) {
    const invoice = event.data.object as Stripe.Invoice;
    // Type check for subscription property
    if (!('subscription' in invoice) || typeof invoice.subscription !== 'string') {
        console.warn(`[${EDGE_FUNCTION_NAME}] ℹ️ invoice.paid event has no subscription ID`);
        return new Response("No subscription", { status: 200 });
    }

    let user_id = "";
    try {
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      user_id = subscription.metadata?.user_id!;
      if (!user_id) {
        console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Missing user_id in subscription metadata for paid event`);
        return new Response("Missing user_id", { status: 200 });
      }

      await updateUserPaymentStatus(user_id, false);

      const plan = subscription.items.data[0].price.nickname ?? "basic";
      const billing_cycle = subscription.items.data[0].price.recurring?.interval ?? "monthly";
      await createOrUpdateSubscription({
        user_id,
        plan,
        billing_cycle,
        stripe_subscription_id: subscription.id,
      });

      console.log(`[${EDGE_FUNCTION_NAME}] 📦 Subscription created/updated for ${user_id}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error processing subscription/payout event: ${errorMessage}`);
      if (err instanceof Error) {
        await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error processing subscription event: ${errorMessage}`);
      }
    }

    return new Response("Subscription created/updated", { status: 200 });
  }

  // 5. Handle checkout.session.completed
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const metadata = session.metadata ?? {};
    const user_id = metadata.user_id as string | undefined;
    const plan_type = metadata.plan_type as string | undefined;
    const plan_option = metadata.plan_option as string | undefined;

    if (!user_id || user_id.length < 3) {
      console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Invalid user_id in session metadata: ${user_id}`);
      return new Response("Invalid user_id", { status: 400 });
    }
    await updateUserPaymentStatus(user_id, false);

    const validPlanTypes = ["tokens", "daily", "monthly", "yearly"];
    const validOneTimeOptions = ["tier1", "tier2", "tier3", "tier4"];
    const validSubscriptionOptions = ["daily", "basic", "standard", "premium", "ultra"];

    if (!plan_type || !plan_option || !validPlanTypes.includes(plan_type)) {
      console.error(`[${EDGE_FUNCTION_NAME}] ❌ Invalid metadata in session: plan_type=${plan_type}, plan_option=${plan_option}`);
      return new Response("Invalid metadata", { status: 400 });
    }

    // One-time token purchase
    if (plan_type === "tokens") {
      try {
        const { data: existingPurchase } = await supabase
          .from("user_token_purchases")
          .select("id")
          .eq("stripe_purchase_id", session.id)
          .maybeSingle();
        if (existingPurchase) {
          console.log(`[${EDGE_FUNCTION_NAME}] ℹ️ Duplicate session purchase: ${session.id}`);
          return new Response("Duplicate session", { status: 200 });
        }

        if (!validOneTimeOptions.includes(plan_option)) {
          console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Invalid plan_option for tokens: ${plan_option}`);
          return new Response("Invalid plan_option", { status: 400 });
        }

        const tokensToAdd = await getOneTimeTokenAmount(plan_option);
        if (!tokensToAdd || tokensToAdd <= 0) {
          console.error(`[${EDGE_FUNCTION_NAME}] ❌ Invalid token amount: ${tokensToAdd}`);
          return new Response("Invalid token amount", { status: 400 });
        }

        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 60);

        const { data: purchaseRow, error: purchaseError } = await supabase
          .from("user_token_purchases")
          .insert({
            user_id,
            plan: plan_option,
            stripe_purchase_id: session.id,
            is_active: true,
            current_period_start: new Date().toISOString(),
            current_period_end: endDate.toISOString(),
            amount: tokensToAdd,
          })
          .select("id")
          .single();

        if (purchaseError || !purchaseRow) {
          throw purchaseError ?? new Error("Insert error in user_token_purchases");
        }

        await supabase.from("user_token_batches").insert({
          user_id,
          source: "purchase",
          purchase_id: purchaseRow.id,
          amount: tokensToAdd,
          consumed: 0,
          is_active: true,
          expires_at: endDate.toISOString(),
        });

        console.log(`[${EDGE_FUNCTION_NAME}] 🎉 One-time token purchase recorded for ${user_id}, amount=${tokensToAdd}`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error handling one-time purchase for ${user_id}: ${errorMessage}`);
        if (err instanceof Error) {
          await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error handling purchase for ${user_id}: ${errorMessage}`);
        }
        return new Response("Internal server error", { status: 500 });
      }

      return new Response("OK", { status: 200 });
    }

    // New subscription via checkout
    if (["daily", "monthly", "yearly"].includes(plan_type)) {
      try {
        const stripeSubId = session.subscription?.toString() ?? "";
        const { data: existingSub } = await supabase
          .from("subscriptions")
          .select("id")
          .eq("stripe_subscription_id", stripeSubId)
          .maybeSingle();
        if (existingSub) {
          console.log(`[${EDGE_FUNCTION_NAME}] ℹ️ Duplicate subscription registration: ${stripeSubId}`);
          return new Response("Duplicate subscription", { status: 200 });
        }

        if (!["daily", "basic", "standard", "premium", "ultra"].includes(plan_option)) {
          console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ Invalid plan_option for subscription: ${plan_option}`);
          return new Response("Invalid plan_option", { status: 400 });
        }

        await createOrUpdateSubscription({
          user_id,
          plan: plan_option,
          billing_cycle: plan_type,
          stripe_subscription_id: stripeSubId || null,
        });

        console.log(`[${EDGE_FUNCTION_NAME}] ✅ New subscription created for ${user_id}`);

        // Referral Logic
        try {
          const { data: referralData, error: referralError } = await supabase
            .from("referrals")
            .select("id, referrer_user_id, is_rewarded")
            .eq("referred_user_id", user_id)
            .single();

          if (referralError) {
            console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ No referral found or error for referred user ${user_id}: ${referralError.message}`);
          } else if (referralData && !referralData.is_rewarded) {
            if (!REFERRAL_TOKEN_AMOUNT) {
              console.warn(`[${EDGE_FUNCTION_NAME}] ⚠️ REFERRAL_TOKEN_AMOUNT not set, skipping referral reward.`);
            } else {
              const tokens = parseInt(REFERRAL_TOKEN_AMOUNT);
              if (!isNaN(tokens) && tokens > 0) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 365); // Expire referral tokens after one year

                await supabase.from("user_token_batches").insert({
                  user_id: referralData.referrer_user_id,
                  source: "referral",
                  amount: tokens,
                  consumed: 0,
                  is_active: true,
                  expires_at: expiresAt.toISOString(),
                });

                await supabase.from("referrals").update({ is_rewarded: true }).eq("id", referralData.id);

                console.log(`[${EDGE_FUNCTION_NAME}] 🎁 Issued ${tokens} referral tokens to referrer ${referralData.referrer_user_id}`);
              }
            }
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error handling referral logic: ${errorMessage}`);
          if (err instanceof Error) {
            await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error handling referral logic: ${errorMessage}`);
          }
        }

      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[${EDGE_FUNCTION_NAME}] ❌ Error handling subscription checkout for ${user_id}: ${errorMessage}`);
        if (err instanceof Error) {
          await notifyTelegram(`${EDGE_FUNCTION_NAME} / ❌ Error handling subscription checkout for ${user_id}: ${errorMessage}`);
        }
        return new Response("Internal server error", { status: 500 });
      }

      return new Response("OK", { status: 200 });
    }

    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Invalid plan_type received in session: ${plan_type}`);
    return new Response("Invalid plan_type", { status: 400 });
  }

  console.log(`[${EDGE_FUNCTION_NAME}] ℹ️ Received unhandled event type: ${event.type}`);
  return new Response("Ignored event", { status: 200 });
});
