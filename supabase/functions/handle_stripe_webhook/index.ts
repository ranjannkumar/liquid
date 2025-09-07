/**
 * Edge Function: handle_stripe_webhook.ts (corrected)
 *
 * Processes Stripe webhook events, aligned with the canonical specification.
 * - Verifies webhook signature.
 * - `invoice.paid` / `invoice.payment_succeeded` is the SINGLE source of truth for subs & refills.
 * - Robust user resolution and plan lookup via subscription_prices(price_id + plan_type).
 * - Supports daily/weekly/monthly/yearly cadences (yearly refills monthly).
 * - Idempotent via webhook_events (best-effort; skipped if table missing).
 * - One-time token purchases handled on checkout.session.completed (mode=payment).
 */

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "handle_stripe_webhook";

// ==== ENV ====
const STRIPE_SECRET_KEY         = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET     = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TELEGRAM_BOT_KEY          = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID");
const REFERRAL_TOKEN_AMOUNT     = Deno.env.get("REFERRAL_TOKEN_AMOUNT");

if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  const errMsg = `[${EDGE_FUNCTION_NAME}] ❌ Missing required environment variables.`;
  console.error(errMsg);
  if (TELEGRAM_BOT_KEY && TELEGRAM_CHAT_ID) {
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: errMsg }),
    });
  }
  throw new Error(errMsg);
}

const stripe = new Stripe(STRIPE_SECRET_KEY); // no invalid apiVersion override
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ==== HELPERS ====

async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
    if (!res.ok) console.error(`[${EDGE_FUNCTION_NAME}] ❌ Telegram API error: ${await res.text()}`);
  } catch (err) {
    console.error(`[${EDGE_FUNCTION_NAME}] ❌ Failed to send Telegram message: ${String(err)}`);
  }
}

type PlanType = "daily" | "weekly" | "monthly" | "yearly";

function normalizeInterval(i?: string): PlanType {
  switch (i) {
    case "day":   return "daily";
    case "week":  return "weekly";
    case "month": return "monthly";
    case "year":  return "yearly";
    default:      return "monthly";
  }
}

function addDurationToDate(base: Date, planType: PlanType): Date {
  const d = new Date(base);
  if (planType === "daily") d.setDate(d.getDate() + 1);
  else if (planType === "weekly") d.setDate(d.getDate() + 7);
  else if (planType === "monthly") d.setMonth(d.getMonth() + 1);
  else if (planType === "yearly") d.setMonth(d.getMonth() + 1); // yearly still refills monthly per spec
  return d;
}

async function getSubscriptionTokenAmountByPrice(price: Stripe.Price): Promise<number> {
  const plan_type = normalizeInterval(price.recurring?.interval);
  // Your table stores price_id, so query by that + plan_type
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens")
    .eq("price_id", price.id)
    .eq("plan_type", plan_type)
    .maybeSingle();

  if (error || !data) {
    const errMsg = `No subscription_tokens for price_id=${price.id}, plan_type=${plan_type}`;
    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ❌ ${errMsg}`);
    throw new Error(errMsg);
  }
  return data.tokens;
}

async function resolveUserIdFromContext(
  subscription: Stripe.Subscription,
  invoice?: Stripe.Invoice
): Promise<string | null> {
  // 1) subscription metadata
  const meta = subscription.metadata as Record<string, string> | undefined;
  const metaUser = meta?.user_id;
  if (metaUser) return metaUser;

  // 2) invoice/customer → users.stripe_customer_id
  const customerId =
    (invoice?.customer as string | undefined) ||
    (subscription.customer as string | undefined);
  if (customerId) {
    const { data } = await supabase
      .from("users")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }

  // 3) customer email → users.email
  if (typeof subscription.customer === "string") {
    const cust = (await stripe.customers.retrieve(subscription.customer)) as Stripe.Customer;
    if (cust.email) {
      const { data } = await supabase
        .from("users")
        .select("user_id")
        .eq("email", cust.email)
        .maybeSingle();
      if (data?.user_id) return data.user_id;
    }
  }

  return null;
}

async function upsertSubscriptionAndGrantBatch(user_id: string, stripeSub: Stripe.Subscription) {
  const price = stripeSub.items.data[0].price as Stripe.Price;
  const plan_type: PlanType = normalizeInterval(price.recurring?.interval);
  const tokenBase = await getSubscriptionTokenAmountByPrice(price);

  // deactivate any other active subscriptions for this user (keep the same stripe id alive)
  {
    const { error } = await supabase
      .from("subscriptions")
      .update({ is_active: false })
      .eq("user_id", user_id)
      .neq("stripe_subscription_id", stripeSub.id);
    if (error) console.error(`[${EDGE_FUNCTION_NAME}] deactivation error`, error);
  }

  // amount semantics:
  // - yearly: store 12× monthly tokens (spec); daily/weekly/monthly: tokenBase per cycle
  const amountForSub =
    plan_type === "yearly" ? tokenBase * 12 : tokenBase;

  const payload = {
    user_id,
    plan: price.id, // store the Stripe price id as the plan key (robust)
    billing_cycle: plan_type,
    stripe_subscription_id: stripeSub.id,
    is_active: true,
    amount: amountForSub,
    // Stripe gives seconds since epoch
    current_period_start: new Date((stripeSub as any).current_period_start * 1000).toISOString(),
    current_period_end:   new Date((stripeSub as any).current_period_end   * 1000).toISOString(),
    last_monthly_refill:  plan_type === "yearly" ? new Date().toISOString() : null,
  };

  // upsert by stripe_subscription_id
  const { data: subRow, error: subErr } = await supabase
    .from("subscriptions")
    .upsert(payload, { onConflict: "stripe_subscription_id" })
    .select("id")
    .single();
  if (subErr || !subRow) {
    console.error(`[${EDGE_FUNCTION_NAME}] subscription upsert error`, subErr);
    throw subErr ?? new Error("Failed to upsert subscription");
  }

  // deactivate older subscription batches
  {
    const { error } = await supabase
      .from("user_token_batches")
      .update({ is_active: false })
      .eq("user_id", user_id)
      .eq("source", "subscription");
    if (error) console.error(`[${EDGE_FUNCTION_NAME}] batch deactivate error`, error);
  }

  // grant one batch for this paid invoice; expiry by cadence
  const now = new Date();
  const expiresAt = addDurationToDate(now, plan_type);

  const { error: batchErr } = await supabase.from("user_token_batches").insert({
    user_id,
    source: "subscription",
    subscription_id: subRow.id,
    amount: plan_type === "yearly" ? tokenBase : tokenBase, // yearly refills monthly with tokenBase
    is_active: true,
    expires_at: expiresAt.toISOString(),
  });
  if (batchErr) {
    console.error(`[${EDGE_FUNCTION_NAME}] batch insert error`, batchErr);
    throw batchErr;
  }

  const { error: userUpErr } = await supabase
    .from("users")
    .update({ has_active_subscription: true, has_payment_issue: false })
    .eq("user_id", user_id);
  if (userUpErr) console.error(`[${EDGE_FUNCTION_NAME}] user update error`, userUpErr);

  console.log(`[${EDGE_FUNCTION_NAME}] ✅ Subscription upserted & ${plan_type} batch granted for ${user_id}`);
}

async function recordIdempotency(eventId: string, type: string): Promise<boolean> {
  // Best-effort; if table doesn't exist, ignore and process.
  try {
    const { error } = await supabase
      .from("webhook_events")
      .insert({ id: eventId, type });
    if (error) {
      // duplicate → ignore further processing
      if ((error as any).code === "23505") {
        console.log(`[${EDGE_FUNCTION_NAME}] ⚠️ Duplicate event ${eventId} ignored`);
        return false;
      }
      // table missing or other error → just log and continue
      console.warn(`[${EDGE_FUNCTION_NAME}] webhook_events insert warning:`, error);
      return true;
    }
    return true;
  } catch (e) {
    console.warn(`[${EDGE_FUNCTION_NAME}] webhook_events insert exception:`, e);
    return true;
  }
}

// ==== SERVER ====

serve(async (req: Request) => {
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig!, STRIPE_WEBHOOK_SECRET!);
    console.log(`[${EDGE_FUNCTION_NAME}] ℹ️ Received event: ${event.type}`);
  } catch (err) {
    const msg = `[${EDGE_FUNCTION_NAME}] ❌ Webhook signature verification failed: ${String(err)}`;
    console.error(msg);
    await notifyTelegram(msg);
    return new Response(`Webhook Error: ${String(err)}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.created": {
        const customer = event.data.object as Stripe.Customer;
        if (customer.email) {
          const { error } = await supabase
            .from("users")
            .update({ stripe_customer_id: customer.id })
            .eq("email", customer.email);
          if (error) console.error(`[${EDGE_FUNCTION_NAME}] users.update error`, error);
          else console.log(`[${EDGE_FUNCTION_NAME}] ✅ Synced stripe_customer_id for ${customer.email}`);
        }
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // ONE-TIME TOKEN PURCHASES ONLY
        if (session.mode === "payment") {
          // idempotency (optional for purchases; Stripe id is unique)
          const meta = session.metadata ?? {};
          const user_id = (meta as any).user_id;
          const plan_option = (meta as any).plan_option;

          if (!user_id || !plan_option) {
            console.warn(`[${EDGE_FUNCTION_NAME}] checkout.session.completed missing user_id/plan_option in metadata`);
            return new Response("OK", { status: 200 });
          }

          // prevent duplicate purchase row
          const { data: existing } = await supabase
            .from("user_token_purchases")
            .select("id")
            .eq("stripe_purchase_id", session.id)
            .maybeSingle();
          if (existing) {
            console.log(`[${EDGE_FUNCTION_NAME}] ⚠️ Duplicate checkout session ${session.id} ignored.`);
            return new Response("OK", { status: 200 });
          }

          const { data: priceRow, error: priceErr } = await supabase
            .from("token_prices")
            .select("tokens")
            .eq("plan_option", plan_option)
            .maybeSingle();
          if (priceErr || !priceRow) throw new Error(`Token price not found for plan_option=${plan_option}`);

          const now = new Date();
          const expiresAt = new Date(now);
          expiresAt.setDate(expiresAt.getDate() + 60);

          const { data: purchase, error: purchaseErr } = await supabase
            .from("user_token_purchases")
            .insert({
              user_id,
              plan: plan_option,
              stripe_purchase_id: session.id,
              amount: priceRow.tokens,
              current_period_start: now.toISOString(),
              current_period_end: expiresAt.toISOString(),
            })
            .select("id")
            .single();
          if (purchaseErr) throw purchaseErr;

          const { error: batchErr } = await supabase.from("user_token_batches").insert({
            user_id,
            source: "purchase",
            purchase_id: purchase.id,
            amount: priceRow.tokens,
            is_active: true,
            expires_at: expiresAt.toISOString(),
          });
          if (batchErr) throw batchErr;

          console.log(`[${EDGE_FUNCTION_NAME}] 🎉 One-time purchase for ${user_id} completed.`);
        }
        break;
      }

     type InvoiceWithSub = Stripe.Invoice & { subscription?: string | null };

case "invoice.paid":
case "invoice.payment_succeeded": {
  const proceed = await recordIdempotency(event.id, event.type);
  if (!proceed) return new Response("Duplicate", { status: 200 });

  const invoice = event.data.object as InvoiceWithSub;
  const subscriptionId = invoice.subscription ?? null;
  if (!subscriptionId) return new Response("OK", { status: 200 });

  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
        const user_id = await resolveUserIdFromContext(stripeSub, invoice);
        if (!user_id) {
          const msg = `[${EDGE_FUNCTION_NAME}] ❌ Cannot resolve user_id for subscription ${subscriptionId}`;
          console.error(msg);
          await notifyTelegram(msg);
          return new Response("OK", { status: 200 });
        }

        await upsertSubscriptionAndGrantBatch(user_id, stripeSub);

        // Referral reward on first invoice of subscription
        if (invoice.billing_reason === "subscription_create") {
          const { data: ref } = await supabase
            .from("referrals")
            .select("id, referrer_user_id, is_rewarded")
            .eq("referred_user_id", user_id)
            .maybeSingle();
          if (ref && !ref.is_rewarded) {
            const tokens = parseInt(REFERRAL_TOKEN_AMOUNT || "0", 10);
            if (tokens > 0) {
              const expiresAt = new Date();
              expiresAt.setDate(expiresAt.getDate() + 365);
              const { error: r1 } = await supabase.from("user_token_batches").insert({
                user_id: ref.referrer_user_id,
                source: "referral",
                amount: tokens,
                is_active: true,
                expires_at: expiresAt.toISOString(),
              });
              if (r1) console.error(`[${EDGE_FUNCTION_NAME}] referral batch insert error`, r1);
              const { error: r2 } = await supabase
                .from("referrals")
                .update({ is_rewarded: true })
                .eq("id", ref.id);
              if (r2) console.error(`[${EDGE_FUNCTION_NAME}] referral update error`, r2);
              else console.log(`[${EDGE_FUNCTION_NAME}] 🎁 Issued ${tokens} referral tokens to ${ref.referrer_user_id}`);
            }
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customer_id = invoice.customer as string;
        const { data: user } = await supabase
          .from("users")
          .select("user_id")
          .eq("stripe_customer_id", customer_id)
          .maybeSingle();
        if (user?.user_id) {
          const { error } = await supabase
            .from("users")
            .update({ has_payment_issue: true })
            .eq("user_id", user.user_id);
          if (error) console.error(`[${EDGE_FUNCTION_NAME}] mark payment issue error`, error);
          else console.log(`[${EDGE_FUNCTION_NAME}] 🚨 Payment failed for user ${user.user_id}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const { error } = await supabase
          .from("subscriptions")
          .update({ is_active: false })
          .eq("stripe_subscription_id", subscription.id);
        if (error) console.error(`[${EDGE_FUNCTION_NAME}] deactivate sub error`, error);

        const u = (subscription.metadata as Record<string, string> | undefined)?.user_id;
        if (u) {
          const { error: upErr } = await supabase
            .from("users")
            .update({ has_active_subscription: false })
            .eq("user_id", u);
          if (upErr) console.error(`[${EDGE_FUNCTION_NAME}] user deactivate error`, upErr);
        }
        console.log(`[${EDGE_FUNCTION_NAME}] 🔕 Subscription cancelled for ${u ?? "unknown user"}`);
        break;
      }

      default:
        console.log(`[${EDGE_FUNCTION_NAME}] 🤷‍♀️ Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    const errorMessage = `[${EDGE_FUNCTION_NAME}] ❌ Error processing event ${event.type}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(errorMessage);
    await notifyTelegram(errorMessage);
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }

  return new Response("OK", { status: 200 });
});
