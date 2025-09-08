// supabase/functions/handle_stripe_webhook/index.ts

import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "handle_stripe_webhook";

// ================= ENV =================
const STRIPE_SECRET_KEY         = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET     = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_KEY          = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID");
const REFERRAL_TOKEN_AMOUNT     = parseInt(Deno.env.get("REFERRAL_TOKEN_AMOUNT") ?? "0", 10);

// ================ CLIENTS ================
const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ================ UTILS =================
const log = (m: string) => console.log(`[${EDGE_FUNCTION_NAME}] ${m}`);

async function notifyTelegram(message: string) {
  if (!TELEGRAM_BOT_KEY || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_KEY}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch {/* ignore */}
}

/** Safe epoch→ISO; null if invalid */
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

/** Subscription batch expiry = next window (daily/weekly/monthly) */
function addExpiry(from: Date, planType: PlanType) {
  const d = new Date(from);
  if (planType === "daily") d.setDate(d.getDate() + 1);
  else if (planType === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1); // monthly & yearly => +1 month
  return d;
}

/** Event-level idempotency (not used for credits) */
async function recordEventOnce(id: string, type: string) {
  const { error } = await supabase.from("webhook_events").insert({ id, type });
  if (!error) return true;
  if ((error as any)?.code === "23505") return false;
  log(`webhook_events warn: ${error?.message ?? String(error)}`);
  return true; // best-effort
}

/** Invoice-level idempotency (EXACTLY-ONCE credit per invoice) */
async function recordInvoiceOnce(invoiceId: string) {
  const key = `invoice:${invoiceId}`;
  const { error } = await supabase.from("webhook_events").insert({ id: key, type: "invoice" });
  if (!error) return true;
  if ((error as any)?.code === "23505") return false;
  log(`invoice idempotency warn: ${error?.message ?? String(error)}`);
  return true; // best-effort
}

/** Resolve user_id from subscription metadata → customer id → email */
async function resolveUserId(sub: Stripe.Subscription, invoice?: Stripe.Invoice) {
  const metaUser = (sub.metadata as Record<string, string> | undefined)?.user_id;
  if (metaUser) return metaUser;

  const custId = (invoice?.customer as string) || (sub.customer as string);
  if (custId) {
    const { data } = await supabase
      .from("users")
      .select("user_id")
      .eq("stripe_customer_id", custId)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }

  if (typeof sub.customer === "string") {
    const cust = (await stripe.customers.retrieve(sub.customer)) as Stripe.Customer;
    if (cust.email) {
      const { data } = await supabase.from("users").select("user_id").eq("email", cust.email).maybeSingle();
      if (data?.user_id) return data.user_id;
    }
  }
  return null;
}

/** Monthly tokens for a price from subscription_prices */
async function tokensForSubscriptionPrice(price: Stripe.Price): Promise<number> {
  const planType = normalizeInterval(price.recurring?.interval);
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens")
    .eq("price_id", price.id)
    .eq("plan_type", planType)
    .maybeSingle();
  if (error || !data) throw new Error(`No tokens in subscription_prices for price_id=${price.id}/${planType}`);
  return data.tokens;
}

// ================ SERVER =================
serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig!, STRIPE_WEBHOOK_SECRET);
    log(`received ${event.type}`);
  } catch (e) {
    const msg = `signature verification failed: ${e instanceof Error ? e.message : String(e)}`;
    log(msg);
    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
    return new Response("Bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      // -------------------- ONE-TIME PURCHASE --------------------
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "payment") break; // subscription credits come from invoices

        // idempotency via purchase id
        const { data: exists } = await supabase
          .from("user_token_purchases")
          .select("id")
          .eq("stripe_purchase_id", session.id)
          .maybeSingle();
        if (exists) break;

        const meta = session.metadata ?? {};
        const user_id = (meta as any).user_id;
        const plan_option = (meta as any).plan_option; // tier1..tier5

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

      // ---------------- SUBSCRIPTION STATE SYNC ------------------
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

      // -------------- CREDIT TOKENS (ONCE PER INVOICE) -----------
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        // Use *invoice.id* idempotency so both events credit only once
        const invBase = event.data.object as Stripe.Invoice;

        // Guard: Stripe typings allow id?: string
        const invoiceId: string | null = typeof invBase.id === "string" ? invBase.id : null;
        if (!invoiceId) {
          log(`skip invoice: missing invoice.id`);
          break;
        }

        // Only process truly paid invoices
        if (invBase.status !== "paid") {
          log(`skip invoice ${invoiceId}: status=${invBase.status}`);
          break;
        }

        // Idempotency per invoice
        if (!(await recordInvoiceOnce(invoiceId))) {
          log(`duplicate for invoice ${invoiceId}, skipping`);
          return new Response("duplicate invoice", { status: 200 });
        }

        // subscription on invoice/lines may be string OR object
        type InvoiceWithLines = Stripe.Invoice & {
          subscription?: string | Stripe.Subscription | null;
          lines: { data: Array<{ subscription?: string | Stripe.Subscription | null }> };
        };
        const inv = invBase as InvoiceWithLines;

        // 1) Try invoice.subscription
        let subscriptionId: string | null = null;
        const invSub = inv.subscription;
        if (typeof invSub === "string") {
          subscriptionId = invSub;
        } else if (invSub && typeof invSub === "object" && "id" in invSub) {
          subscriptionId = (invSub as Stripe.Subscription).id;
        }

        // 2) Recover from line items if needed
        if (!subscriptionId) {
          const lineWithSub = inv.lines?.data?.find((l) => !!l.subscription);
          if (lineWithSub?.subscription) {
            const lineSub = lineWithSub.subscription;
            subscriptionId =
              typeof lineSub === "string" ? lineSub : (lineSub as Stripe.Subscription).id ?? null;
            log(`recovered subscription from invoice line: ${subscriptionId}`);
          }
        }

        // 3) Fallback: customer's latest subscription
        if (!subscriptionId && typeof inv.customer === "string") {
          try {
            const list = await stripe.subscriptions.list({
              customer: inv.customer,
              status: "all",
              limit: 1,
            });
            if (list.data[0]) {
              subscriptionId = list.data[0].id;
              log(`fell back to customer's latest subscription: ${subscriptionId}`);
            }
          } catch (e) {
            log(`could not list subscriptions for customer ${inv.customer}: ${String(e)}`);
          }
        }

        if (!subscriptionId) {
          log(`invoice ${invoiceId} has no subscription, ignoring`);
          break;
        }

        // Resolve user and price
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const user_id = await resolveUserId(sub, inv);
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

        // Deactivate prior subscription batches for this user
        const { error: deactErr } = await supabase
          .from("user_token_batches")
          .update({ is_active: false })
          .eq("user_id", user_id)
          .eq("source", "subscription");
        if (deactErr) log(`deactivate warn: ${deactErr.message}`);

        // Upsert subscription row (keep periods current)
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

        // Insert single monthly batch for this invoice
        const expiresAt = addExpiry(new Date(), planType);
        const { error: batchErr } = await supabase.from("user_token_batches").insert({
          user_id,
          source: "subscription",
          subscription_id: subscriptionRowId,
          amount: monthlyTokens,               // monthly grant, even for yearly plans
          consumed: 0,                         // remove if your schema doesn't have it
          is_active: true,                     // remove if your schema doesn't have it
          expires_at: expiresAt.toISOString(), // remove if your schema doesn't have it
        });
        if (batchErr) throw batchErr;

        await supabase
          .from("users")
          .update({ has_active_subscription: true, has_payment_issue: false })
          .eq("user_id", user_id);

        // Referral bonus (first invoice only)
        if (inv.billing_reason === "subscription_create" && REFERRAL_TOKEN_AMOUNT > 0) {
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
              log(`referral insert failed: ${refErr.message}`);
            }
          }
        }

        log(`credited ${monthlyTokens} tokens to user=${user_id} (subRow=${subscriptionRowId})`);
        break;
      }

      // ------------------- PAYMENT FAILURE FLAG -------------------
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
