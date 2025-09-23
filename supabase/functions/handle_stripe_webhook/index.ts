import { serve } from "https://deno.land/std/http/server.ts";
import Stripe from "npm:stripe";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "handle_stripe_webhook";

// ================= ENV =================
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_KEY = Deno.env.get("TELEGRAM_BOT_KEY");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const REFERRAL_TOKEN_AMOUNT = parseInt(Deno.env.get("REFERRAL_TOKEN_AMOUNT") ?? "0", 10);

// ================ CLIENTS ================
const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ================ UTILS =================
const log = (m: string) => console.log(`[${EDGE_FUNCTION_NAME}] ${m}`);
const stringifyErr = (e: unknown) => {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
};

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

/** epoch→ISO or null */
function epochToIso(sec?: number | null): string | null {
  return (typeof sec === "number" && Number.isFinite(sec))
    ? new Date(sec * 1000).toISOString()
    : null;
}

/** Map Stripe interval to your DB enum (daily|monthly|yearly). Note: week -> monthly */
type DbCycle = "daily" | "monthly" | "yearly";
function dbCycleFromStripe(i?: string | null): DbCycle {
  if (i === "day") return "daily";
  if (i === "year") return "yearly";
  return "monthly"; // default for 'month' and also for 'week'
}

/** Add expiry from start date using DB cycle */
function addExpiry(from: Date, cycle: DbCycle) {
  const d = new Date(from);
  if (cycle === "daily") d.setDate(d.getDate() + 1);
  else if (cycle === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

/** Idempotency (unique "id" PK in webhook_events) */
async function recordEventOnce(eventId: string, eventType: string) {
  const { error } = await supabase.from("webhook_events").insert({ id: eventId, type: eventType });
  if (!error) return true;
  if ((error as any)?.code === "23505") {
    log(`duplicate event ${eventType}:${eventId}, skipping`);
    return false;
  }
  log(`event idempotency warn: ${stringifyErr(error)}`);
  return true;
}

/** Resolve user_id via sub.metadata.user_id, users.stripe_customer_id, or customer email */
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

/** Lookup subscription catalog row (price + tokens) by Stripe price_id */
async function getSubscriptionCatalog(priceId: string): Promise<{ tokens: number | null; price: number | null, plan_option: string | null }> {
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens, price, plan_option")
    .eq("price_id", priceId)
    .maybeSingle();

  if (error || !data) return { tokens: null, price: null, plan_option: null };
  return { tokens: data.tokens ?? null, price: data.price ?? null, plan_option: data.plan_option ?? null }; // price in currency units
}

/** Amount in cents from catalog (preferred) or Stripe price.unit_amount */
function subscriptionAmountCents(dbPrice: number | null, stripePrice: Stripe.Price): number {
  if (typeof dbPrice === "number") return Math.round(dbPrice * 100);
  if (typeof stripePrice.unit_amount === "number") return stripePrice.unit_amount;
  const dec = (stripePrice as any).unit_amount_decimal as string | undefined;
  return dec ? Math.round(parseFloat(dec)) : 0;
}

/** Tokens per month for subscription price id */
async function tokensForSubscriptionPrice(price: Stripe.Price): Promise<number> {
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("tokens")
    .eq("price_id", price.id)
    .maybeSingle();

  if (error || !data) throw new Error(`No tokens in subscription_prices for price_id=${price.id}`);
  return data.tokens;
}

/** Get local subscription row UUID by Stripe subscription id */
async function getLocalSubscriptionId(stripeSubId: string): Promise<string | null> {
  const { data } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("stripe_subscription_id", stripeSubId)
    .maybeSingle();
  return data?.id ?? null;
}

// Stripe's Deno types omit `subscription` on Invoice; extend locally
type InvoiceWithSub = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
};

// ================ HELPER FUNCTIONS =================
async function handleReferralReward(referred_user_id: string) {
  if (REFERRAL_TOKEN_AMOUNT <= 0) {
    log(`Referral token amount is not set or is zero. Skipping referral reward for ${referred_user_id}.`);
    return;
  }
  
  const { data: referralData, error: referralError } = await supabase
    .from("referrals")
    .select("id, referrer_user_id")
    .eq("referred_user_id", referred_user_id)
    .eq("is_rewarded", false)
    .maybeSingle();

  if (referralError) {
    log(`Error fetching referral data for ${referred_user_id}: ${stringifyErr(referralError)}`);
    return;
  }

  if (referralData) {
    const { id: referral_id, referrer_user_id } = referralData;
    log(`Referral conversion detected: referred_user_id=${referred_user_id}, referrer_user_id=${referrer_user_id}`);
    
    // Check for a duplicate reward
    const { data: existingReward, error: existingRewardError } = await supabase
      .from("user_token_batches")
      .select("id")
      .eq("source", "referral")
      .eq("user_id", referrer_user_id)
      .maybeSingle();

    if (existingReward) {
      log(`Referral reward already granted to ${referrer_user_id}. Skipping.`);
      return;
    }
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365); // Expire in one year
    
    // Grant the token batch
    const { data: newBatch, error: batchError } = await supabase.from("user_token_batches").insert({
      user_id: referrer_user_id,
      source: "referral",
      amount: REFERRAL_TOKEN_AMOUNT,
      consumed: 0,
      is_active: true,
      expires_at: expiresAt.toISOString(),
      note: `Referral: ${referred_user_id}`,
    }).select("id").single();
    
    if (batchError) {
      log(`Error inserting referral token batch: ${stringifyErr(batchError)}`);
      throw batchError;
    }

    // Update the referral record to prevent double-granting
    const { error: updateError } = await supabase
      .from("referrals")
      .update({ is_rewarded: true })
      .eq("id", referral_id);
    
    if (updateError) {
      log(`Error updating referral record: ${stringifyErr(updateError)}`);
      throw updateError;
    }
    
    // Log the token credit
    await supabase.from("token_event_logs").insert({
      user_id: referrer_user_id,
      batch_id: newBatch.id,
      delta: REFERRAL_TOKEN_AMOUNT,
      reason: "referral_reward",
    });
    
    log(`Successfully granted ${REFERRAL_TOKEN_AMOUNT} tokens to referrer ${referrer_user_id}`);
  }
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
    const msg = `signature verification failed: ${stringifyErr(e)}`;
    log(msg);
    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
    return new Response("Bad signature", { status: 400 });
  }

  try {
    if (event.id && !(await recordEventOnce(event.id, event.type))) {
      return new Response("duplicate event", { status: 200 });
    }

    switch (event.type) {
      // -------------------- CHECKOUT COMPLETED --------------------
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const meta = (session.metadata ?? {}) as Record<string, string>;
        const user_id = meta.user_id;

        // Persist stripe_customer_id early (used by later events)
        if (user_id && session.customer) {
          const customerId = typeof session.customer === "string" ? session.customer : session.customer.id;
          const { error: updateErr } = await supabase
            .from("users")
            .update({ stripe_customer_id: customerId })
            .eq("user_id", user_id);
          if (updateErr) log(`Failed to update stripe_customer_id for user ${user_id}: ${stringifyErr(updateErr)}`);
          else log(`Updated user ${user_id} with Stripe customer ID: ${customerId}`);
        }

        // Subscription checkouts are handled by subsequent events
        if (session.mode === "subscription") break;

        // One-time purchase flow (mode=payment)
        if (session.mode !== "payment") break;

        const plan_option = meta.plan_option;
        const { data: tier, error: tErr } = await supabase
          .from("token_prices")
          .select("tokens")
          .eq("plan_option", plan_option)
          .eq("plan_type", "one_time")
          .maybeSingle();
        if (tErr || !tier) throw new Error(`token_prices not found for ${plan_option}/one_time`);

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 60);

        const discountAmount = session.total_details?.amount_discount ?? 0;

        const { data: purchase, error: perr } = await supabase
          .from("user_token_purchases")
          .insert({
            user_id,
            plan: plan_option,
            stripe_purchase_id: session.id,
            amount: tier.tokens,
            current_period_start: now.toISOString(),
            current_period_end: expiresAt.toISOString(),
            discount_amount: discountAmount / 100,
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
          note: "one-time-purchase"
        });
        if (berr) throw berr;
        
        // Log the token credit
        await supabase.from("token_event_logs").insert({
          user_id,
          batch_id: purchase.id,
          delta: tier.tokens,
          reason: "purchase",
        });

        // --- REFERRAL LOGIC ---
        await handleReferralReward(user_id);
        
        log(`one-time purchase recorded for user=${user_id} purchase_id=${session.id}`);
        break;
      }

      // ---------------- SUBSCRIPTION CREATED ---------------------
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const user_id = await resolveUserId(sub);
        if (!user_id) {
          const warn = `could not resolve user_id for subscription ${sub.id}`;
          log(warn);
          await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${warn}`);
          break; // 200 OK (don’t retry)
        }

        const price = sub.items.data[0].price as Stripe.Price;
        const cycle: DbCycle = dbCycleFromStripe(price.recurring?.interval ?? "month");
        const { price: catalogPrice, tokens: catalogTokens, plan_option: catalogPlanOption } = await getSubscriptionCatalog(price.id);
        const amountCents = subscriptionAmountCents(catalogPrice, price);

        if (catalogTokens === null || catalogPlanOption === null) throw new Error(`Tokens or plan option not found for price_id: ${price.id}`);

        const payload = {
          user_id,
          plan: price.id,                             // Stripe price_id
          plan_option: catalogPlanOption,             // Correctly populate this column
          billing_cycle: cycle,                       // 'daily' | 'monthly' | 'yearly'
          stripe_subscription_id: sub.id,
          is_active: sub.status === "active", // Set active based on Stripe status
          amount: catalogTokens,                      // Store tokens granted, not price
          price_in_cents: amountCents,                // Store price in cents
          current_period_start: epochToIso((sub as any).current_period_start),
          current_period_end:   epochToIso((sub as any).current_period_end),
          last_monthly_refill: null, // Reset for new subscriptions, let cron handle it.
        };

        const { data: newSub, error } = await supabase
          .from("subscriptions")
          .upsert(payload, { onConflict: "stripe_subscription_id" })
          .select("id").single();
        if (error) throw error;
        
        // This block for token granting is intentionally commented out to prevent T3 double-granting.
        // Tokens for initial subscriptions are granted ONLY on invoice.paid.

        await supabase
          .from("users")
          .update({ has_active_subscription: true, has_payment_issue: false })
          .eq("user_id", user_id);

        log(`subscription row upserted for user=${user_id} sub=${sub.id}`);
        break;
      }

      // ---------------- SUBSCRIPTION UPDATED ---------------------
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const price = sub.items.data[0].price as Stripe.Price;
        const cycle: DbCycle = dbCycleFromStripe(price.recurring?.interval ?? "month");

        const { data: oldSub, error: oldSubErr } = await supabase
          .from("subscriptions")
          .select("plan_option")
          .eq("stripe_subscription_id", sub.id)
          .maybeSingle();

        const { price: catalogPrice, tokens: catalogTokens, plan_option: catalogPlanOption } = await getSubscriptionCatalog(price.id);
        const amountCents = subscriptionAmountCents(catalogPrice, price);

        if (catalogTokens === null || catalogPlanOption === null) throw new Error(`Tokens or plan option not found for price_id: ${price.id}`);

        const { error } = await supabase
          .from("subscriptions")
          .update({
            plan: price.id,
            plan_option: catalogPlanOption,
            billing_cycle: cycle,
            amount: catalogTokens,
            price_in_cents: amountCents,
            current_period_start: epochToIso((sub as any).current_period_start),
            current_period_end:   epochToIso((sub as any).current_period_end),
            is_active: sub.status === "active",
          })
          .eq("stripe_subscription_id", sub.id);
        if (error) throw error;
        
        // Bug Fix: Credit tokens immediately on upgrade (T5)
        if (oldSub?.plan_option && oldSub.plan_option !== catalogPlanOption) {
          const user_id = await resolveUserId(sub);
          const localSubId = await getLocalSubscriptionId(sub.id);
          if (user_id && localSubId) {
            const { data: newBatch, error: batchError } = await supabase.from("user_token_batches").insert({
              user_id,
              source: "subscription",
              subscription_id: localSubId,
              amount: catalogTokens,
              consumed: 0,
              is_active: true,
              expires_at: epochToIso((sub as any).current_period_end)!,
              note: `plan-upgrade-from-${oldSub.plan_option}-to-${catalogPlanOption}`
            }).select("id").single();
            if (batchError) throw batchError;
            await supabase.from("token_event_logs").insert({
              user_id,
              batch_id: newBatch.id,
              delta: catalogTokens,
              reason: "subscription_upgrade_credit",
            });
            log(`subscription upgraded and tokens credited for sub=${sub.id}`);
          }
        }

        log(`subscription updated sub=${sub.id}`);
        break;
      }

      // ---------------- SUBSCRIPTION DELETED ---------------------
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const user_id = await resolveUserId(sub);

        const { error } = await supabase
          .from("subscriptions")
          .update({ is_active: false })
          .eq("stripe_subscription_id", sub.id);
        if (error) throw error;

        // The user can still spend remaining tokens, so we don't deactivate batches here.
        if (user_id) {
          await supabase
            .from("users")
            .update({ has_active_subscription: false })
            .eq("user_id", user_id);
        }

        log(`subscription deleted sub=${sub.id}`);
        break;
      }

      // -------------- CREDIT TOKENS (ONCE PER INVOICE) -----------
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const invBase = event.data.object as Stripe.Invoice;
        if (invBase.status !== "paid") {
          log(`skip invoice ${invBase.id}: status=${invBase.status}`);
          break;
        }

        // Do not credit tokens for upgrades here. T5 is handled by customer.subscription.updated.
        if (invBase.billing_reason === 'subscription_update') {
          log(`skip invoice ${invBase.id}: upgrade already handled by subscription.updated`);
          break;
        }

        const inv = invBase as InvoiceWithSub;

        // Best source of truth: invoice.subscription
        let stripeSubId: string | null =
          typeof inv.subscription === "string" ? inv.subscription : null;

        // Fallback: inspect invoice lines
        if (!stripeSubId) {
          const lineWithSub = inv.lines?.data?.find(
            (l) => typeof (l as any).subscription === "string",
          );
          stripeSubId = (lineWithSub?.subscription as string) ?? null;
        }

        // Fallback: customer's active subscription
        if (!stripeSubId && typeof inv.customer === "string") {
          const subs = await stripe.subscriptions.list({
            customer: inv.customer,
            status: "active",
            limit: 1,
          });
          stripeSubId = subs.data[0]?.id ?? null;
        }

        if (!stripeSubId) {
          log(`invoice ${inv.id} has no subscription, ignoring`);
          break;
        }

        const sub = await stripe.subscriptions.retrieve(stripeSubId);
        const user_id = await resolveUserId(sub, invBase);
        if (!user_id) {
          const msg = `could not resolve user_id for subscription ${stripeSubId}`;
          log(msg);
          await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
          break;
        }

        const price = sub.items.data[0].price as Stripe.Price;
        const cycle: DbCycle = dbCycleFromStripe(price.recurring?.interval ?? "month");
        
        // FIX: Credit correct token amount based on billing reason and cycle
        const { data: priceData, error: priceError } = await supabase
          .from("subscription_prices")
          .select("tokens, monthly_refill_tokens")
          .eq("price_id", price.id)
          .maybeSingle();

        if (priceError || !priceData) {
          log(`Error finding price data for price ID: ${price.id}`);
          throw new Error(`Price data not found for price_id: ${price.id}`);
        }
        
        let tokensToCredit = 0;
        const isInitialCreation = inv.billing_reason === "subscription_create";

        if (isInitialCreation) {
            if (cycle === "yearly" && priceData.monthly_refill_tokens) {
                // For initial yearly subscription, credit monthly tokens and update last_monthly_refill
                tokensToCredit = priceData.monthly_refill_tokens;
                await supabase.from("subscriptions").update({ last_monthly_refill: new Date().toISOString() }).eq("stripe_subscription_id", sub.id);
            } else {
                // For initial monthly/daily subscription, credit full amount
                tokensToCredit = priceData.tokens;
            }
        } else {
            // For renewals, credit full amount (yearly renewals are handled by cron)
            tokensToCredit = priceData.tokens;
        }


        // ---------------- Period-end based expiry (production-correct) ----------------
        // Prefer the invoice line's period end (accurate for this credit).
        const recurringLine =
          inv.lines?.data?.find((l) => (l as any).price?.type === "recurring" || l.subscription) ??
          inv.lines?.data?.[0];
        const linePeriodEndSec: number | undefined = (recurringLine as any)?.period?.end;

        // Fallback to subscription's current period end (seconds since epoch)
        const subPeriodEndSec: number | undefined = (sub as any)?.current_period_end;

        // Final fallback: compute now + cycle
        const expiresAtIso =
          epochToIso(linePeriodEndSec ?? subPeriodEndSec) ??
          addExpiry(new Date(), cycle).toISOString();

        // ---------------- Idempotency for this specific token credit ----------------
        // IMPORTANT FIX: Check if a token batch for THIS INVOICE has already been credited.
        const localSubId = await getLocalSubscriptionId(sub.id);

        if (!localSubId) {
            log(`invoice ${inv.id}: local subscription row not found for stripe sub ${sub.id}`);
            // This case should not happen. It suggests the subscription.created event failed.
            break;
        }
        
        // BUG FIX: Use the new invoice_id column for robust idempotency on renewals (T4)
        // Check for an existing batch with the same invoice_id
        const { data: existingBatch, error: existingBatchError } = await supabase
            .from("user_token_batches")
            .select("id")
            .eq("invoice_id", inv.id)
            .maybeSingle();

        if (existingBatchError) {
            log(`Error checking for existing batch for invoice ${inv.id}: ${stringifyErr(existingBatchError)}`);
            throw existingBatchError;
        }
        if (existingBatch) {
            log(`Invoice ${inv.id} already processed for token credit. Skipping.`);
            break; // Already credited, exit.
        }

        // If no existing batch, proceed to insert.
        const { data: newBatch, error: batchError } = await supabase.from("user_token_batches").insert({
          user_id,
          source: "subscription",
          subscription_id: localSubId,
          invoice_id: inv.id, // BUG FIX: Add the invoice ID here
          amount: tokensToCredit, // Use the corrected amount
          consumed: 0,
          is_active: true,
          expires_at: expiresAtIso,
          note: `Subscription: ${sub.id}`
        }).select("id").single();
        
        if (batchError) throw batchError;

        // Log the token credit
        await supabase.from("token_event_logs").insert({
          user_id,
          batch_id: newBatch.id,
          delta: tokensToCredit,
          reason: inv.billing_reason === "subscription_create" ? "subscription_initial_credit" : "subscription_refill",
        });

        await supabase
          .from("users")
          .update({ has_active_subscription: true, has_payment_issue: false })
          .eq("user_id", user_id);

        // --- REFERRAL LOGIC ---
        // This logic is for a new user's first subscription payment.
        if (isInitialCreation) {
          await handleReferralReward(user_id);
        }

        const invoiceId = inv.id ?? `unknown-invoice-${event.id}`;
        log(`credited ${tokensToCredit} tokens to user=${user_id} from invoice=${invoiceId}`);
        break;
      }

      // -------------- PAYMENT INTENT SUCCEEDED -----------
      case "payment_intent.succeeded": {
        const intent = event.data.object as Stripe.PaymentIntent;

        const purchaseId = intent.id;
        const meta = (intent.metadata ?? {}) as Record<string, string>;
        const user_id = meta.user_id;
        const plan_option = meta.plan_option;

        if (!user_id || !plan_option) {
          log("payment_intent.succeeded missing user_id or plan_option in metadata. Skipping.");
          break;
        }

        // Idempotency check: see if a purchase batch for this intent already exists
        const { data: existingPurchase, error: existingPurchaseError } = await supabase
          .from("user_token_purchases")
          .select("id")
          .eq("stripe_purchase_id", purchaseId)
          .maybeSingle();

        if (existingPurchaseError) throw existingPurchaseError;
        if (existingPurchase) {
          log(`duplicate payment_intent.succeeded for purchase ID ${purchaseId}, skipping`);
          break;
        }

        const { data: tier, error: tErr } = await supabase
          .from("token_prices")
          .select("tokens")
          .eq("plan_option", plan_option)
          .maybeSingle();
        if (tErr || !tier) throw new Error(`token_prices not found for ${plan_option}`);

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + 60);

        const { data: purchase, error: perr } = await supabase
          .from("user_token_purchases")
          .insert({
            user_id,
            plan: plan_option,
            stripe_purchase_id: purchaseId,
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
          note: "one-time-purchase-payment-intent",
        });
        if (berr) throw berr;

        log(`one-time purchase recorded via payment_intent for user=${user_id} purchase_id=${purchaseId}`);
        break;
      }

      default:
        break;
    }
  } catch (e) {
    const msg = `error processing ${event.type}: ${stringifyErr(e)}`;
    log(msg);
    await notifyTelegram(`[${EDGE_FUNCTION_NAME}] ${msg}`);
    return new Response("error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});