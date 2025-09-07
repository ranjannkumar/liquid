// supabase/functions/handle_stripe_webhook/index.ts

/**
 * Stripe Webhook handler — aligned to your spec & schema.
 *
 * One-time token packs:
 *   - checkout.session.completed (mode=payment) → user_token_purchases + user_token_batches(source='purchase')
 *
 * Subscriptions (daily/monthly/yearly):
 *   - customer.subscription.created/updated/deleted → keep subscriptions table in sync (NO credits here)
 *   - invoice.paid / invoice.payment_succeeded       → the ONLY place we grant subscription token batches
 *
 * Idempotency: webhook_events(id) prevents duplicate effects on re-delivery.
 */

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "handle_stripe_webhook";

// Env
const STRIPE_SECRET_KEY         = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET     = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_KEY          = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID");
const REFERRAL_TOKEN_AMOUNT     = parseInt(Deno.env.get("REFERRAL_TOKEN_AMOUNT") ?? "0", 10);

// Clients
const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- helpers ----------

type PlanType = "daily" | "weekly" | "monthly" | "yearly";
const normalizeInterval = (i?: string): PlanType =>
  i === "day" ? "daily" : i === "week" ? "weekly" : i === "year" ? "yearly" : "monthly";

const addExpiry = (d: Date, p: PlanType) => {
  const x = new Date(d);
  if (p === "daily") x.setDate(x.getDate() + 1);
  else if (p === "weekly") x.setDate(x.getDate() + 7);
  else x.setMonth(x.getMonth() + 1); // monthly/yearly → 1 month window
  return x;
};

/** Safely converts Stripe epoch seconds → ISO string; returns null if missing/invalid. */
function epochToIso(sec?: number | null): string | null {
  return (typeof sec === "number" && Number.isFinite(sec))
    ? new Date(sec * 1000).toISOString()
    : null;
}

async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch { /* ignore */ }
}

async function recordEventOnce(eventId: string, type: string): Promise<boolean> {
  const { error } = await supabase.from("webhook_events").insert({ id: eventId, type });
  if (!error) return true;
  if ((error as any).code === "23505") return false; // duplicate
  console.warn("webhook_events insert warning:", error);
  return true; // best-effort if table missing
}

async function resolveUserId(subscription: Stripe.Subscription, invoice?: Stripe.Invoice): Promise<string | null> {
  // 1) metadata on subscription
  const metaUser = (subscription.metadata as Record<string, string> | undefined)?.user_id;
  if (metaUser) return metaUser;

  // 2) by stripe_customer_id
  const custId = (invoice?.customer as string) || (subscription.customer as string);
  if (custId) {
    const { data } = await supabase.from("users").select("user_id").eq("stripe_customer_id", custId).maybeSingle();
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

// ---------- webhook ----------

serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature!, STRIPE_WEBHOOK_SECRET);
    console.log(`[${EDGE_FUNCTION_NAME}] received ${event.type}`);
  } catch (err) {
    const msg = `[${EDGE_FUNCTION_NAME}] signature verification failed: ${String(err)}`;
    console.error(msg);
    await notifyTelegram(msg);
    return new Response("Bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      // ----------------- ONE-TIME TOKEN PACKS -----------------
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "payment") break; // Subscriptions credited on invoice.paid

        // idempotency by purchase id
        const { data: exists } = await supabase
          .from("user_token_purchases")
          .select("id")
          .eq("stripe_purchase_id", session.id)
          .maybeSingle();
        if (exists) break;

        const meta = session.metadata ?? {};
        const user_id = (meta as any).user_id;
        const plan_option = (meta as any).plan_option; // tier1..tier5
        // plan_type from metadata is not strictly required here; we always read 'one_time'.

        const { data: tier } = await supabase
          .from("token_prices")
          .select("tokens")
          .eq("plan_option", plan_option)
          .eq("plan_type", "one_time")
          .maybeSingle();
        if (!tier) throw new Error(`token_prices not found for ${plan_option}/one_time`);

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 60); // business rule

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

      // ----------------- SUBSCRIPTIONS: STATE SYNC -----------------
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const user_id = await resolveUserId(sub);
        if (!user_id) break;

        const price = sub.items.data[0].price as Stripe.Price;
        const planType = normalizeInterval(price.recurring?.interval);
        const monthlyTokens = await tokensForSubscriptionPrice(price);

        const payload = {
          user_id,
          plan: price.id, // store Stripe price_id
          billing_cycle: planType,
          stripe_subscription_id: sub.id,
          is_active: true,
          amount: monthlyTokens * (planType === "yearly" ? 12 : 1),
          // SAFELY handle possibly-missing period times
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

      // ----------------- SUBSCRIPTIONS: CREDITS (SINGLE SOURCE OF TRUTH) -----------------
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        // idempotency: only credit once per event id
        if (!(await recordEventOnce(event.id, event.type)))
          return new Response("duplicate", { status: 200 });

        type InvoiceWithSub = Stripe.Invoice & { subscription?: string | null };
        const invoice = event.data.object as InvoiceWithSub;
        const subscriptionId = invoice.subscription ?? null;
        if (!subscriptionId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const user_id = await resolveUserId(sub, invoice);
        if (!user_id) break;

        const price = sub.items.data[0].price as Stripe.Price;
        const planType = normalizeInterval(price.recurring?.interval);
        const monthlyTokens = await tokensForSubscriptionPrice(price);

        // Deactivate older subscription batches for the user
        await supabase
          .from("user_token_batches")
          .update({ is_active: false })
          .eq("user_id", user_id)
          .eq("source", "subscription");

        // Ensure the subscription row is up to date
        const { data: dbSub } = await supabase
          .from("subscriptions")
          .upsert(
            {
              user_id,
              plan: price.id,
              billing_cycle: planType,
              stripe_subscription_id: sub.id,
              is_active: true,
              amount: monthlyTokens * (planType === "yearly" ? 12 : 1),
              current_period_start: epochToIso((sub as any).current_period_start),
              current_period_end:   epochToIso((sub as any).current_period_end),
              last_monthly_refill:  planType === "yearly" ? new Date().toISOString() : null,
            },
            { onConflict: "stripe_subscription_id" },
          )
          .select("id")
          .single();

        // Create the new active batch for this invoice
        const expiresAt = addExpiry(new Date(), planType);
        await supabase.from("user_token_batches").insert({
          user_id,
          source: "subscription",
          subscription_id: dbSub?.id ?? null,
          amount: monthlyTokens,  // yearly still grants monthly tokens per invoice cadence
          consumed: 0,
          is_active: true,
          expires_at: expiresAt.toISOString(),
        });

        // Clear payment issue flag
        await supabase
          .from("users")
          .update({ has_active_subscription: true, has_payment_issue: false })
          .eq("user_id", user_id);

        // Referral reward (first invoice only)
        if (invoice.billing_reason === "subscription_create" && REFERRAL_TOKEN_AMOUNT > 0) {
          const { data: ref } = await supabase
            .from("referrals")
            .select("id, referrer_user_id, is_rewarded")
            .eq("referred_user_id", user_id)
            .maybeSingle();
          if (ref && !ref.is_rewarded) {
            const exp = new Date();
            exp.setDate(exp.getDate() + 365);
            await supabase.from("user_token_batches").insert({
              user_id: ref.referrer_user_id,
              source: "referral",
              amount: REFERRAL_TOKEN_AMOUNT,
              consumed: 0,
              is_active: true,
              expires_at: exp.toISOString(),
              note: `Referral reward for ${user_id}`,
            });
            await supabase.from("referrals").update({ is_rewarded: true }).eq("id", ref.id);
          }
        }
        break;
      }

      // ----------------- PAYMENT FAILURE -----------------
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
        // ignore other events
        break;
    }
  } catch (e) {
    const msg = `[${EDGE_FUNCTION_NAME}] error processing ${event.type}: ${e instanceof Error ? e.message : String(e)}`;
    console.error(msg);
    await notifyTelegram(msg);
    return new Response("error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
