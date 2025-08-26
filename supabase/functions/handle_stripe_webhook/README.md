# Stripe Webhook Handler Edge Function – Backend Contract

## ✅ Endpoint
- **Public**  
- Listens for Stripe webhook events at this route (no request body format required).

---

## 🔒 Security
- Verifies `stripe-signature` header using `STRIPE_WEBHOOK_SECRET`.
- Rejects requests with invalid signatures (returns 400).

---

## 🔁 Response (200 OK)
- Returns plain text responses:
  - `"Invoice payment failed processed"`
  - `"Subscription cancelled"`
  - `"Subscription created/updated"`
  - `"OK"`
  - `"Ignored event"`

---

## ❗ Error Responses

| Status | Error Type                    | Message                                               |
| ------ | ----------------------------- | ----------------------------------------------------- |
| 400    | Signature Verification Error  | Webhook signature error                               |
| 400    | Missing user_id               | `"Missing user_id"`                                   |
| 400    | Invalid user_id               | `"Invalid user_id"`                                   |
| 400    | Invalid metadata              | `"Invalid metadata"`                                  |
| 400    | Invalid plan_option           | `"Invalid plan_option"`                               |
| 500    | Internal Server Error         | `"Internal server error"` (on database/Stripe errors) |

---

## ⚙️ Environment Variables (Edge Function)

```
STRIPE_SECRET_KEY=...          (Your Stripe secret key)
STRIPE_WEBHOOK_SECRET=...      (Stripe webhook signing secret)
SUPABASE_URL=...               (Your Supabase project URL)
SUPABASE_SERVICE_ROLE_KEY=...  (Service-role key for Supabase)
DOMAIN=...                     (Your frontend domain, e.g., https://example.com)
TELEGRAM_BOT_KEY=...           (Bot token for sending critical notifications)
TELEGRAM_CHAT_ID=...           (Telegram chat ID for notifications)
```

---

## ✅ Validation & Preflight Checks

| Check                                 | Status | Description                                                                                                            |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Environment variable presence         | ✅     | Verifies `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` are set.         |
| Webhook signature verification         | ✅     | Uses `stripe.webhooks.constructEventAsync` with `stripe-signature` and `STRIPE_WEBHOOK_SECRET`.                        |
| Event type handling                    | ✅     | Supports: `invoice.payment_failed`, `customer.subscription.deleted`, `invoice.paid`, `customer.subscription.updated`, `checkout.session.completed`. |
| JSON metadata validation               | ✅     | Ensures `user_id`, `plan_type`, `plan_option` are present for relevant events.                                        |
| Database operations                     | ✅     | Performs SELECT, UPDATE, INSERT on `users`, `subscriptions`, `user_token_batches`, `user_token_purchases`.            |
| Error handling & logging                | ✅     | All errors logged with `[handle_stripe_webhook]` prefix; critical failures trigger Telegram notifications.            |

---

## 🔐 Security Measures

| Area                                     | Status | Description                                                                                                                     |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Webhook signature verification            | ✅     | Validates `stripe-signature` header against `STRIPE_WEBHOOK_SECRET`.                                                             |
| Supabase Service Role Key usage          | ✅     | Uses service-role key only in Edge Function; never exposed to clients.                                                           |
| Data integrity and idempotency           | ✅     | Checks for existing purchases/subscriptions to avoid duplicates.                                                                |
| Least privilege principle                | ✅     | Edge Function only updates specific rows in the database; no broad permissions.                                                  |
| Error notifications via Telegram         | ✅     | On critical database/logic failures, sends a Telegram alert with error details (excluding sensitive data).                      |

---

## 📡 Event Processing Workflow

1. **Verify Webhook Signature**  
   - Read raw request body and `stripe-signature` header.  
   - Call `stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET)`  
   - If verification fails → return 400.

2. **Handle `invoice.payment_failed`**  
   - Extract `user_id` from `invoice.metadata.user_id` or fetch via `stripe.subscriptions.retrieve(...)`.  
   - If `user_id` found:
     - Call `updateUserPaymentStatus(user_id, true)` → sets `users.has_payment_issue = true`.  
     - Log:  
       ```
       [handle_stripe_webhook] 🚨 Invoice payment failed for user: <user_id>
       ```  
   - If `user_id` missing → log warning.  
   - Return 200 "Invoice payment failed processed".

3. **Handle `customer.subscription.deleted`**  
   - Extract `user_id` from `subscription.metadata.user_id`.  
   - If missing → return 400 "Missing user_id".  
   - Update `subscriptions.is_active = false`, `users.has_active_subscription = false`, `users.has_payment_issue = true`.  
   - Log:  
     ```
     [handle_stripe_webhook] 🔕 Subscription cancelled for <user_id>
     ```  
   - Return 200 "Subscription cancelled".

4. **Handle `invoice.paid` & `customer.subscription.updated`**  
   - Ensure `invoice.subscription` exists; if not → return 200 "No subscription".  
   - Retrieve full subscription from Stripe using ID.  
   - Extract `user_id` from `subscription.metadata.user_id`.  
   - If missing → return 200 "Missing user_id".  
   - Call `updateUserPaymentStatus(user_id, false)` → clears `has_payment_issue`.  
   - Determine `plan` from `subscription.items.data[0].price.nickname`.  
   - Determine `billing_cycle` from `subscription.items.data[0].price.recurring.interval`.  
   - Call `createOrUpdateSubscription({user_id, plan, billing_cycle, stripe_subscription_id: subscription.id})`.  
   - Log:  
     ```
     [handle_stripe_webhook] 📦 Subscription created/updated for <user_id>
     ```  
   - Return 200 "Subscription created/updated".

5. **Handle `checkout.session.completed`**  
   - Extract session metadata: `user_id`, `plan_type`, `plan_option`.  
   - If `user_id` invalid → return 400 "Invalid user_id".  
   - Call `updateUserPaymentStatus(user_id, false)`.  
   - Validate `plan_type` ∈ ["tokens", "daily", "monthly", "yearly"].  
   - If `plan_type === "tokens"`:  
     - Query `user_token_purchases` for existing `stripe_purchase_id = session.id`; if found → log and return 200 "Duplicate session".  
     - Validate `plan_option` ∈ ["tier1", "tier2", "tier3", "tier4"]; else → return 400 "Invalid plan_option".  
     - Call `getOneTimeTokenAmount(plan_option)` → get `tokensToAdd`.  
     - Validate `tokensToAdd > 0`; else → return 400 "Invalid token amount".  
     - Calculate `current_period_end = now + 60 days`.  
     - Insert into `user_token_purchases`: `{user_id, plan: plan_option, stripe_purchase_id: session.id, is_active: true, current_period_start: now, current_period_end, amount: tokensToAdd}`.  
     - Insert into `user_token_batches`: `{user_id, source: "purchase", purchase_id: <inserted ID>, amount: tokensToAdd, consumed: 0, is_active: true, expires_at: current_period_end}`.  
     - Log:  
       ```
       [handle_stripe_webhook] 🎉 One-time token purchase recorded for <user_id>, amount=<tokensToAdd>
       ```  
     - Return 200 "OK".

   - Else (`plan_type ∈ ["daily","monthly","yearly"]`):  
     - Retrieve `session.subscription` ID.  
     - Query `subscriptions` table for existing `stripe_subscription_id`; if found → log and return 200 "Duplicate subscription".  
     - Validate `plan_option` ∈ ["daily","basic","standard","premium","ultra"]; else → return 400 "Invalid plan_option".  
     - Call `createOrUpdateSubscription({user_id, plan: plan_option, billing_cycle: plan_type, stripe_subscription_id: session.subscription})`.  
     - Log:  
       ```
       [handle_stripe_webhook] ✅ New subscription created for <user_id>
       ```  
     - Return 200 "OK".

   - Else → log and return 400 "Invalid plan_type".  

6. **Unhandled Events**  
   - Log:  
     ```
     [handle_stripe_webhook] ℹ️ Received unhandled event type: <event.type>
     ```  
   - Return 200 "Ignored event".

---

*End of contract for the `handle_stripe_webhook` Edge Function.*  
