// supabase/functions/handle_stripe_webhook/index.ts

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "handle_stripe_webhook";

// ---- env ----
const STRIPE_SECRET_KEY         = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET     = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_KEY          = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID");
const REFERRAL_TOKEN_AMOUNT     = parseInt(Deno.env.get("REFERRAL_TOKEN_AMOUNT") ?? "0", 10);

// ---- clients ----
const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---- helpers ----
function log(msg: string) {
  console.log(`[${EDGE_FUNCTION_NAME}] ${msg}`);
}

async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch {
    // ignore
  }
}

/** Return ISO string or null if missing/invalid (prevents "Invalid time value"). */
function epochToIso(sec?: number | null): string | null {
  return (typeof sec === "number" && Number.isFinite(sec))
    ? new Date(sec * 1000).toISOString()
    : null;
}

type PlanType = "daily" | "weekly" | "monthly" | "yearly";
function normalizeInterval(i?: string): PlanType {
  if (i === "day") return "daily";
  if (i === "week") return "weekly";
  if (i === "year") return "yearly";
  return "monthly";
}

/** expiry for batches granted by subscriptions.
 *  Business rule: credits expire with the *next* refill window.
 *  daily→+1 day, weekly→+7 days, monthly/yearly→+1 month
 */
function addExpiry(from: Date, planType: PlanType) {
  const d = new Date(from);
  if (planType === "daily") d.setDate(d.getDate() + 1);
  else if (planType === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1); // monthly & yearly -> 1 month
  return d;
}

/** Idempotency table (webhook_events.id PK). Returns true if first time, false if duplicate. */
async function recordEventOnce(id: string, type: string) {
  const { error } = await supabase.from("webhook_events").insert({ id, type });
  if (!error) return true;
  if ((error as any)?.code === "23505") return false; // duplicate
  // If table isn’t there or some other warning, log and continue best-effort
  log(`webhook_events insert warning: ${error?.message ?? String(error)}`);
  return true;
}

/** Resolve a user_id from subscription metadata, stripe_customer_id, or email. */
async function resolveUserId(subscription: Stripe.Subscription, invoice?: Stripe.Invoice) {
  // 1) metadata
  const metaUser = (subscription.metadata as Record<string, string> | undefined)?.user_id;
  if (metaUser) return metaUser;

  // 2) by stripe_customer_id
  const custId = (invoice?.customer as string) || (subscription.customer as string);
  if (custId) {
    const { data } = await supabase
      .from("users")
      .select("user_id")
      .eq("stripe_customer_id", custId)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }

  // 3) by email
  if (typeof subscription.customer === "string") {
    const cust = (await stripe.customers.retrieve(subscription.customer)) as Stripe.Customer;
    if (cust.email) {
      const { data } = await supabase.from("users").select("user_id").eq("email", cust.email).maybeSingle();
      if (data?.user_id) return data.user_id;
    }
  }
  return null;
}

/** Lookup monthly tokens for a Stripe price from subscription_prices. */
async function tokensForSubscriptionPrice(price: Stripe.Price): Promise<number> {
  const planType = normalizeInterval(price.recurring?.interval);
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens")
    .eq("price_id", price.id)
    .eq("plan_type", planType)
    .maybeSingle();
  if (error || !data) throw new Error(`No subscription_prices.tokens for price_id=${price.id} / ${planType}`);
  return data.tokens;
}

// ------------------------------------------------------------------------------------------------

serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig!, STRIPE_WEBHOOK_SECRET);
    log(`received ${event.type}`);
  } catch (e) {
    const msg = `signature verification failed: ${e instanceof Error ? e.message : String(e)}`;
    log(msg);
    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
    return new Response("Bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      // ==========================
      // ONE-TIME TOKEN PURCHASES
      // ==========================
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "payment") break; // subscriptions credited via invoice.paid

        // idempotency by purchase id
        const { data: exists } = await supabase
          .from("user_token_purchases")
          .select("id")
          .eq("stripe_purchase_id", session.id)
          .maybeSingle();
        if (exists) break;

        const meta = session.metadata ?? {};
        const user_id = (meta as any).user_id;
        const plan_option = (meta as any).plan_option; // e.g. tier1..tier5

        const { data: tier } = await supabase
          .from("token_prices")
          .select("tokens")
          .eq("plan_option", plan_option)
          .eq("plan_type", "one_time")
          .maybeSingle();
        if (!tier) throw new Error(`token_prices not found for ${plan_option}/one_time`);

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 60);

        const { data: purchase, error: perr } = await supabase
          .from("user_token_purchases")
          .insert({
            user_id,
            plan: plan_option,
            stripe_purchase_id: session.id,
            amount: tier.tokens,
            current_period_start: now.toISOString(),
            current_period_end: expiresAt.toISOString(),
          })
          .select("id")
          .single();
        if (perr) throw perr;

        const { error: berr } = await supabase.from("user_token_batches").insert({
          user_id,
          source: "purchase",
          purchase_id: purchase.id,
          amount: tier.tokens,
          consumed: 0,
          is_active: true,
          expires_at: expiresAt.toISOString(),
        });
        if (berr) throw berr;

        break;
      }

      // ==========================
      // SUBSCRIPTION STATE SYNC
      // ==========================
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const user_id = await resolveUserId(sub);
        if (!user_id) break;

        const price = sub.items.data[0].price as Stripe.Price;
        const planType = normalizeInterval(price.recurring?.interval);
        const monthlyTokens = await tokensForSubscriptionPrice(price);

        const payload = {
          user_id,
          plan: price.id,
          billing_cycle: planType,
          stripe_subscription_id: sub.id,
          is_active: true,
          amount: monthlyTokens * (planType === "yearly" ? 12 : 1),
          current_period_start: epochToIso((sub as any).current_period_start),
          current_period_end:   epochToIso((sub as any).current_period_end),
          last_monthly_refill:  planType === "yearly" ? new Date().toISOString() : null,
        };

        const { error } = await supabase
          .from("subscriptions")
          .upsert(payload, { onConflict: "stripe_subscription_id" });
        if (error) throw error;

        await supabase.from("users").update({ has_active_subscription: true }).eq("user_id", user_id);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const price = sub.items.data[0].price as Stripe.Price;
        const planType = normalizeInterval(price.recurring?.interval);

        const { error } = await supabase
          .from("subscriptions")
          .update({
            plan: price.id,
            billing_cycle: planType,
            current_period_start: epochToIso((sub as any).current_period_start),
            current_period_end:   epochToIso((sub as any).current_period_end),
          })
          .eq("stripe_subscription_id", sub.id);
        if (error) throw error;

        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const { error } = await supabase
          .from("subscriptions")
          .update({ is_active: false })
          .eq("stripe_subscription_id", sub.id);
        if (error) throw error;
        break;
      }

      // ==========================================================
      // SUBSCRIPTIONS: GRANT TOKENS (SINGLE SOURCE OF TRUTH)
      // ==========================================================
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        if (!(await recordEventOnce(event.id, event.type))) {
          log(`duplicate ${event.type} ${event.id}, skipping`);
          return new Response("duplicate", { status: 200 });
        }

        // Stripe typing: subscription on invoice & line can be string or object
        type InvoiceWithLines = Stripe.Invoice & {
          subscription?: string | Stripe.Subscription | null;
          lines: { data: Array<{ subscription?: string | Stripe.Subscription | null }> };
        };
        const invoice = event.data.object as InvoiceWithLines;

        // 1) normal place
        let subscriptionId: string | null = null;
        const invSub = invoice.subscription;
        if (typeof invSub === "string") {
          subscriptionId = invSub;
        } else if (invSub && typeof invSub === "object" && "id" in invSub) {
          subscriptionId = (invSub as Stripe.Subscription).id;
        }

        // 2) recover from invoice lines when root is null
        if (!subscriptionId) {
          const lineWithSub = invoice.lines?.data?.find((l) => !!l.subscription);
          if (lineWithSub?.subscription) {
            const lineSub = lineWithSub.subscription;
            subscriptionId =
              typeof lineSub === "string"
                ? lineSub
                : (lineSub as Stripe.Subscription).id ?? null;

            log(`recovered subscription from invoice line: ${subscriptionId}`);
          }
        }

        // 3) best-effort fallback to customer's latest subscription
        if (!subscriptionId && typeof invoice.customer === "string") {
          try {
            const list = await stripe.subscriptions.list({
              customer: invoice.customer,
              status: "all",
              limit: 1,
            });
            if (list.data[0]) {
              subscriptionId = list.data[0].id;
              log(`fell back to customer's latest subscription: ${subscriptionId}`);
            }
          } catch (e) {
            log(`could not list subscriptions for customer ${invoice.customer}: ${String(e)}`);
          }
        }

        if (!subscriptionId) {
          log(`invoice ${invoice.id} has no subscription, ignoring.`);
          break;
        }

        // proceed
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const user_id = await resolveUserId(sub, invoice);
        if (!user_id) {
          const msg = `could not resolve user_id for subscription ${subscriptionId}`;
          log(msg);
          await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
          break;
        }

        const price = sub.items.data[0].price as Stripe.Price;
        const planType = normalizeInterval(price.recurring?.interval);
        const monthlyTokens = await tokensForSubscriptionPrice(price);
        log(`will credit ${monthlyTokens} tokens to user=${user_id} for sub=${sub.id} (${planType})`);

        // deactivate previous subscription batches for user
        const { error: deactErr } = await supabase
          .from("user_token_batches")
          .update({ is_active: false })
          .eq("user_id", user_id)
          .eq("source", "subscription");
        if (deactErr) log(`deactivate old batches warning: ${deactErr.message}`);

        // upsert subscription row (keeps period times updated)
        const upsertPayload = {
          user_id,
          plan: price.id,
          billing_cycle: planType,
          stripe_subscription_id: sub.id,
          is_active: true,
          amount: monthlyTokens * (planType === "yearly" ? 12 : 1),
          current_period_start: epochToIso((sub as any).current_period_start),
          current_period_end:   epochToIso((sub as any).current_period_end),
          last_monthly_refill:  planType === "yearly" ? new Date().toISOString() : null,
        };

        const { data: upserted, error: upsertErr } = await supabase
          .from("subscriptions")
          .upsert(upsertPayload, { onConflict: "stripe_subscription_id" })
          .select("id")
          .single();
        if (upsertErr) throw upsertErr;

        // ensure we have the subscriptions.id
        let subscriptionRowId = upserted?.id ?? null;
        if (!subscriptionRowId) {
          const { data: found, error: findErr } = await supabase
            .from("subscriptions")
            .select("id")
            .eq("stripe_subscription_id", sub.id)
            .single();
          if (findErr) throw findErr;
          subscriptionRowId = found.id;
        }

        // create the new batch
        const expiresAt = addExpiry(new Date(), planType);
        const { error: batchErr } = await supabase.from("user_token_batches").insert({
          user_id,
          source: "subscription",
          subscription_id: subscriptionRowId,
          amount: monthlyTokens,                 // monthly grant even for yearly plans
          consumed: 0,                           // adjust/remove if your schema differs
          is_active: true,                       // adjust/remove if your schema differs
          expires_at: expiresAt.toISOString(),   // adjust/remove if your schema differs
        });
        if (batchErr) throw batchErr;

        await supabase
          .from("users")
          .update({ has_active_subscription: true, has_payment_issue: false })
          .eq("user_id", user_id);

        // Referral bonus on first invoice only
        if (invoice.billing_reason === "subscription_create" && REFERRAL_TOKEN_AMOUNT > 0) {
          const { data: ref } = await supabase
            .from("referrals")
            .select("id, referrer_user_id, is_rewarded")
            .eq("referred_user_id", user_id)
            .maybeSingle();
          if (ref && !ref.is_rewarded) {
            const exp = new Date(); exp.setDate(exp.getDate() + 365);
            const { error: refErr } = await supabase.from("user_token_batches").insert({
              user_id: ref.referrer_user_id,
              source: "referral",
              amount: REFERRAL_TOKEN_AMOUNT,
              consumed: 0,
              is_active: true,
              expires_at: exp.toISOString(),
              note: `Referral reward for ${user_id}`,
            });
            if (!refErr) {
              await supabase.from("referrals").update({ is_rewarded: true }).eq("id", ref.id);
            } else {
              log(`referral batch insert failed: ${refErr.message}`);
            }
          }
        }

        log(`credited ${monthlyTokens} tokens to user=${user_id} (subRow=${subscriptionRowId})`);
        break;
      }

      // ==========================
      // PAYMENT FAILURE FLAG
      // ==========================
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const custId = invoice.customer as string;
        const { data: u } = await supabase
          .from("users")
          .select("user_id")
          .eq("stripe_customer_id", custId)
          .maybeSingle();
        if (u?.user_id) {
          await supabase.from("users").update({ has_payment_issue: true }).eq("user_id", u.user_id);
        }
        break;
      }

      default:
        // ignore others
        break;
    }
  } catch (e) {
    const msg = `error processing ${event.type}: ${e instanceof Error ? e.message : String(e)}`;
    log(msg);
    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
    return new Response("error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
