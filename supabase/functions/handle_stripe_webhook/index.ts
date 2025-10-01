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

// ---- Failure reason extraction (robust) ----
// Stripe's Invoice typings in Deno may omit `.charge`. Widen locally.
// --- Local type wideners for gaps in Stripe's Deno typings ---
// --- Local wideners for gaps in Stripe's Deno typings ---
type InvoiceWide = Stripe.Invoice & {
  payment_intent?: string | Stripe.PaymentIntent | null;
  charge?: string | Stripe.Charge | null;
  subscription?: string | Stripe.Subscription | null;
};

// PaymentIntent sometimes carries .invoice in the API payload
type PaymentIntentWide = Stripe.PaymentIntent & {
  invoice?: string | Stripe.Invoice | null;
};

// Charge sometimes carries .invoice in the API payload
type ChargeWide = Stripe.Charge & {
  invoice?: string | Stripe.Invoice | null;
};




async function extractFailureReasonFromInvoice(
  stripe: Stripe,
  inv: Stripe.Invoice
): Promise<string> {
  // 0) Re-fetch the invoice with expansions — event payloads can be thin
  let freshInv: InvoiceWide = inv as any;
try {
  const invId = (inv as any).id as string | undefined;
  if (invId) {
    freshInv = (await stripe.invoices.retrieve(invId, {
      expand: ["payment_intent", "payment_intent.latest_charge"],
    })) as any as InvoiceWide;
  }
} catch {
  // proceed with whatever we have
}


  // --- Helper to format messages from a Charge ---
  const fromCharge = (ch: Stripe.Charge) => {
    const parts: string[] = [];
    if (ch.failure_code) parts.push(`failure_code=${ch.failure_code}`);
    if (ch.outcome?.reason) parts.push(`outcome_reason=${ch.outcome.reason}`);
    if (ch.outcome?.seller_message) parts.push(`seller_message=${ch.outcome.seller_message}`);
    if (ch.failure_message) parts.push(`failure_message=${ch.failure_message}`);
    return parts.length ? `charge: ${parts.join(", ")}` : "";
  };

  // --- 1) Prefer PaymentIntent → last_payment_error / latest_charge (from fresh invoice) ---
  try {
    const piId =
      typeof freshInv.payment_intent === "string"
        ? freshInv.payment_intent
        : freshInv.payment_intent?.id;

    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
      const lpe = pi.last_payment_error;
      if (lpe?.message || lpe?.code || lpe?.decline_code) {
        const parts: string[] = [];
        if (lpe.code) parts.push(`code=${lpe.code}`);
        if (lpe.decline_code) parts.push(`decline_code=${lpe.decline_code}`);
        if (lpe.message) parts.push(`message=${lpe.message}`);
        return `payment_intent: ${parts.join(", ")}`;
      }
      const lc = pi.latest_charge as Stripe.Charge | null;
      if (lc) {
        const msg = fromCharge(lc);
        if (msg) return msg;
      }
    }
  } catch {
    // continue to other sources
  }

  // --- 2) Try invoice.charge directly (present on some invoices) ---
  // 2) Try invoice.charge
try {
  const chargeIdStr =
    typeof freshInv.charge === "string"
      ? freshInv.charge
      : freshInv.charge?.id; // <- coerce object to id if present

  if (chargeIdStr) {
    const ch = await stripe.charges.retrieve(chargeIdStr);
    const msg = fromCharge(ch);
    if (msg) return msg;
  }
} catch {
  // continue
}


  // --- 3) NEW: Search PaymentIntents by invoice id (list doesn't support invoice filter) ---
  try {
    const invId = (inv as any).id as string | undefined;
    if (invId && (stripe.paymentIntents as any).search) {
      const searchRes = await (stripe.paymentIntents as any).search({
        query: `invoice:"${invId}"`,
        limit: 1,
      });
      const pi = searchRes?.data?.[0] as Stripe.PaymentIntent | undefined;
      if (pi) {
        const lpe = pi.last_payment_error;
        if (lpe?.message || lpe?.code || lpe?.decline_code) {
          const parts: string[] = [];
          if (lpe.code) parts.push(`code=${lpe.code}`);
          if (lpe.decline_code) parts.push(`decline_code=${lpe.decline_code}`);
          if (lpe.message) parts.push(`message=${lpe.message}`);
          return `payment_intent: ${parts.join(", ")}`;
        }
        // expand latest_charge if needed
        const piFull = await stripe.paymentIntents.retrieve(pi.id, { expand: ["latest_charge"] });
        const lc = piFull.latest_charge as Stripe.Charge | null;
        if (lc) {
          const msg = fromCharge(lc);
          if (msg) return msg;
        }
      }
    }
  } catch {
    // continue
  }

  // --- 4) NEW: If subscription exists, fetch and expand latest_invoice.payment_intent.latest_charge ---
  // 4) If subscription exists, fetch and expand latest_invoice.payment_intent.latest_charge
try {
  const subId =
    typeof freshInv.subscription === "string"
      ? freshInv.subscription
      : freshInv.subscription?.id;

  if (subId) {
    const sub = await stripe.subscriptions.retrieve(subId, {
      expand: [
        "latest_invoice.payment_intent",
        "latest_invoice.payment_intent.latest_charge",
      ],
    });

    const latest = sub.latest_invoice as (InvoiceWide | null) | undefined;
    const pi =
      latest &&
      (typeof latest.payment_intent === "object"
        ? (latest.payment_intent as Stripe.PaymentIntent)
        : undefined);

    if (pi) {
      const lpe = pi.last_payment_error;
      if (lpe?.message || lpe?.code || lpe?.decline_code) {
        const parts: string[] = [];
        if (lpe.code) parts.push(`code=${lpe.code}`);
        if (lpe.decline_code) parts.push(`decline_code=${lpe.decline_code}`);
        if (lpe.message) parts.push(`message=${lpe.message}`);
        return `payment_intent: ${parts.join(", ")}`;
      }
      const lc = pi.latest_charge as Stripe.Charge | null;
      if (lc) {
        const msg = fromCharge(lc);
        if (msg) return msg;
      }
    }
  }
} catch {
  // continue
}

  // --- NEW: Diagnose *why* no attempt happened so we can store a useful reason ---
  try {
    // 1) Collection method check (manual invoices never auto-pay)
    if (freshInv.collection_method === "send_invoice") {
      return `no_automatic_payment: collection_method=send_invoice`;
    }

    // 2) For charge_automatically, see if customer lacks a default PM
    const custId =
      typeof freshInv.customer === "string"
        ? freshInv.customer
        : (freshInv.customer as Stripe.Customer | null)?.id;

    if (custId) {
      const cust = (await stripe.customers.retrieve(custId)) as Stripe.Customer;
      const hasDefaultPM =
        !!cust.invoice_settings?.default_payment_method ||
        !!(cust as any).default_source; // legacy sources

      if (!hasDefaultPM) {
        return `no_payment_method_on_file: customer has no default payment method`;
      }
    }

    // 3) If we got here, invoice is charge_automatically but still no PI/Charge visible.
    // This is usually an ordering/race in test flows; tell the truth:
    return `no_attempt_yet: invoice open with no payment_intent or charge`;
  } catch {
    // fall through to the generic "unknown" wording below if any lookup failed
  }


  // --- 5) Final fallback — still write something useful, never leave NULL on real failures ---
  const attemptCount = (inv.attempt_count ?? 0).toString();
  const nextAttempt = inv.next_payment_attempt
    ? new Date(inv.next_payment_attempt * 1000).toISOString()
    : "n/a";
  return `unknown: status=${inv.status}, attempt_count=${attemptCount}, next_attempt=${nextAttempt}`;
}

function formatReasonFromPI(pi: Stripe.PaymentIntent): string | null {
  const lpe = pi.last_payment_error;
  if (lpe?.message || lpe?.code || lpe?.decline_code) {
    const parts: string[] = [];
    if (lpe.code) parts.push(`code=${lpe.code}`);
    if (lpe.decline_code) parts.push(`decline_code=${lpe.decline_code}`);
    if (lpe.message) parts.push(`message=${lpe.message}`);
    return `payment_intent: ${parts.join(", ")}`;
  }
  const lc = pi.latest_charge as Stripe.Charge | null;
  if (lc && (lc.failure_message || lc.outcome?.reason || lc.outcome?.seller_message)) {
    const parts: string[] = [];
    if (lc.failure_code) parts.push(`failure_code=${lc.failure_code}`);
    if (lc.outcome?.reason) parts.push(`outcome_reason=${lc.outcome.reason}`);
    if (lc.outcome?.seller_message) parts.push(`seller_message=${lc.outcome.seller_message}`);
    if (lc.failure_message) parts.push(`failure_message=${lc.failure_message}`);
    return `charge: ${parts.join(", ")}`;
  }
  return null;
}

async function writeFailureToDb(
  supabase: any,
  user_id: string,
  localSubId: string,
  reason: string
) {
  // update subscriptions row
  const { error: subUpdateError } = await supabase
    .from("subscriptions")
    .update({ is_active: false, payment_failure_reason: reason })
    .eq("id", localSubId);
  if (subUpdateError) throw subUpdateError;

  // flip user flags (non-blocking if you prefer)
  await supabase
    .from("users")
    .update({ has_active_subscription: false, has_payment_issue: true })
    .eq("user_id", user_id);
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

  if (error || !data) throw new Error(`No tokens in subscription_prices for price_id: ${price.id}`);
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
          payment_failure_reason: null, // Initialize failure reason as null
        };

        const { data: newSub, error } = await supabase
          .from("subscriptions")
          .upsert(payload, { onConflict: "stripe_subscription_id" })
          .select("id").single();
        if (error) throw error;
        
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
        if (oldSubErr) throw oldSubErr;

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
        
        // Fix: Credit tokens immediately on upgrade (T5)
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

      // ---------------- PAYMENT FAILED ---------------------
      // ---------------- PAYMENT FAILED ---------------------
case "invoice.payment_failed": {
  const invBase = event.data.object as Stripe.Invoice;
  const inv = invBase as InvoiceWithSub;

  // --- Resolve the related Stripe Subscription ID (unchanged logic + small hardening) ---
  let stripeSubId: string | null =
    typeof inv.subscription === "string" ? inv.subscription : null;

  if (!stripeSubId && inv.lines?.data?.length) {
    const lineWithSub = inv.lines.data.find((l) => typeof (l as any).subscription === "string");
    stripeSubId = (lineWithSub?.subscription as string) ?? null;
  }

  if (!stripeSubId && typeof inv.customer === "string") {
    try {
      const subs = await stripe.subscriptions.list({
        customer: inv.customer,
        status: "all", // include past_due/unpaid/canceled to not miss it
        limit: 1,
      });
      stripeSubId = subs.data[0]?.id ?? null;
    } catch (_e) {
      // ignore; we'll bail out below if still null
    }
  }

  if (!stripeSubId) {
    log(`invoice.payment_failed ${inv.id}: failed to resolve subscription ID, ignoring.`);
    break;
  }

  // --- Extract a robust failure reason (NEW) ---
  const failureReason = await extractFailureReasonFromInvoice(stripe, invBase);

  // --- Find local subscription row ---
  const { data: localSub, error: findErr } = await supabase
    .from("subscriptions")
    .select("id, user_id")
    .eq("stripe_subscription_id", stripeSubId)
    .maybeSingle();
  if (findErr) throw findErr;

  const user_id = localSub?.user_id;
  if (!localSub || !user_id) {
    log(`invoice ${inv.id}: local subscription row not found for stripe_subscription_id=${stripeSubId}`);
    break;
  }

  // --- Update local subscription flags + failure reason ---
  const { error: subUpdateError } = await supabase
    .from("subscriptions")
    .update({
      is_active: false,
      payment_failure_reason: failureReason, // <-- key write
    })
    .eq("id", localSub.id);
  if (subUpdateError) throw subUpdateError;

  // --- Mark user flags so you can trigger emails elsewhere (unchanged) ---
  await supabase
    .from("users")
    .update({ has_active_subscription: false, has_payment_issue: true })
    .eq("user_id", user_id);

  log(
    `payment failed for user=${user_id} sub=${stripeSubId}. Reason: ${failureReason}`
  );

  // If you want to enqueue an email, uncomment and point to your queue/table:
  // await supabase.from("email_queue").insert({
  //   user_id,
  //   template: "payment_failed",
  //   payload: { subscription_id: stripeSubId, reason: failureReason, invoice_id: inv.id },
  // });

  break;
}

case "payment_intent.payment_failed": {
  const piRaw = event.data.object as Stripe.PaymentIntent;
  const pi = piRaw as PaymentIntentWide;

  // Try to get a concrete reason from this PI itself
  let reason = formatReasonFromPI(piRaw);

  // Resolve invoice id from widened PI
  const invoiceId: string | null =
    typeof pi.invoice === "string" ? pi.invoice : pi.invoice?.id ?? null;

  if (!invoiceId) {
    log(`[${EDGE_FUNCTION_NAME}] payment_intent.payment_failed with no invoice on PI ${piRaw.id}`);
    break;
  }

  // Retrieve invoice (expand subscription) to get the Stripe sub id
  const inv = (await stripe.invoices.retrieve(invoiceId, {
    expand: ["subscription"],
  })) as InvoiceWide;

  const stripeSubId: string | null =
    typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? null;

  if (!stripeSubId) {
    log(
      `[${EDGE_FUNCTION_NAME}] PI ${piRaw.id} → invoice ${invoiceId} has no subscription, skipping DB write`,
    );
    break;
  }

  // Look up local subscription row + user
  const { data: localSub, error: findErr } = await supabase
    .from("subscriptions")
    .select("id, user_id")
    .eq("stripe_subscription_id", stripeSubId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!localSub?.id || !localSub.user_id) {
    log(`[${EDGE_FUNCTION_NAME}] No local sub for stripe_subscription_id=${stripeSubId}`);
    break;
  }

  // If reason still empty, refetch PI with latest_charge expanded
  if (!reason) {
    const piFull = await stripe.paymentIntents.retrieve(piRaw.id, {
      expand: ["latest_charge"],
    });
    reason = formatReasonFromPI(piFull) ?? "unknown: from payment_intent";
  }

  await writeFailureToDb(supabase, localSub.user_id, localSub.id, reason);
  log(
    `[${EDGE_FUNCTION_NAME}] payment failed (PI) user=${localSub.user_id} sub=${stripeSubId}. Reason: ${reason}`,
  );
  break;
}



case "charge.failed": {
  const chRaw = event.data.object as Stripe.Charge;
  const ch = chRaw as ChargeWide;

  // Pull invoice id via widened Charge
  const invoiceId: string | null =
    typeof ch.invoice === "string" ? ch.invoice : ch.invoice?.id ?? null;

  if (!invoiceId) break;

  const inv = (await stripe.invoices.retrieve(invoiceId, {
    expand: ["subscription"],
  })) as InvoiceWide;

  const stripeSubId: string | null =
    typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? null;
  if (!stripeSubId) break;

  const { data: localSub } = await supabase
    .from("subscriptions")
    .select("id, user_id")
    .eq("stripe_subscription_id", stripeSubId)
    .maybeSingle();
  if (!localSub?.id || !localSub.user_id) break;

  const parts: string[] = [];
  if (chRaw.failure_code) parts.push(`failure_code=${chRaw.failure_code}`);
  if (chRaw.outcome?.reason) parts.push(`outcome_reason=${chRaw.outcome.reason}`);
  if (chRaw.outcome?.seller_message) parts.push(`seller_message=${chRaw.outcome.seller_message}`);
  if (chRaw.failure_message) parts.push(`failure_message=${chRaw.failure_message}`);
  const reason = parts.length ? `charge: ${parts.join(", ")}` : "unknown: from charge";

  await writeFailureToDb(supabase, localSub.user_id, localSub.id, reason);
  log(
    `[${EDGE_FUNCTION_NAME}] payment failed (charge) user=${localSub.user_id} sub=${stripeSubId}. Reason: ${reason}`,
  );
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

        // Fix: Skip token credit for upgrades handled by customer.subscription.updated (T5)
        if (invBase.billing_reason === 'subscription_cycle') {
          // This is a renewal, which should be handled here.
        } else if (invBase.billing_reason === 'subscription_create') {
          // This is an initial subscription. Proceed with the credit.
        } else if (invBase.billing_reason === 'subscription_update') {
          log(`skip invoice ${invBase.id}: upgrade already handled by subscription.updated`);
          break;
        } else {
            log(`invoice ${invBase.id} has unknown billing reason: ${invBase.billing_reason}, ignoring.`);
            break;
        }

        // FIX: Use InvoiceWithSub to access the subscription property
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
            // FIX: Credit only the first monthly amount for a new yearly subscription
            if (cycle === "yearly" && priceData.monthly_refill_tokens) {
                tokensToCredit = priceData.monthly_refill_tokens;
                await supabase.from("subscriptions").update({ last_monthly_refill: new Date().toISOString() }).eq("stripe_subscription_id", sub.id);
            } else {
                tokensToCredit = priceData.tokens;
            }
        } else {
            // For renewals, credit full amount
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
        const localSubId = await getLocalSubscriptionId(sub.id);

        if (localSubId) {
          await supabase
            .from("subscriptions")
            .update({ payment_failure_reason: null }) // <-- Clear the reason on success
            .eq("id", localSubId);
        }

        if (!localSubId) {
            log(`invoice ${inv.id}: local subscription row not found for stripe sub ${sub.id}`);
            break;
        }
        
        // BUG FIX: Use the new invoice_id column for robust idempotency on renewals (T4)
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
            break;
        }

        const { data: newBatch, error: batchError } = await supabase.from("user_token_batches").insert({
          user_id,
          source: "subscription",
          subscription_id: localSubId,
          invoice_id: inv.id, // BUG FIX: Add the invoice ID here
          amount: tokensToCredit,
          consumed: 0,
          is_active: true,
          expires_at: expiresAtIso,
          note: `Subscription: ${sub.id}`
        }).select("id").single();
        
        if (batchError) throw batchError;

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