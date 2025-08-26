# Stripe Checkout Session Edge Function – Backend Contract

## ✅ Endpoint
```
POST /
Content-Type: application/json
```

---

## 📥 Request Headers
- `Authorization: Bearer <JWT>`  
  - JWT must contain:
    - `sub` claim as `user_id`
    - `email` claim

- CORS:
  - `Access-Control-Allow-Origin: *` (temporary; adjust in production)
  - `Access-Control-Allow-Methods: POST, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type, Authorization`

---

## 🔁 Response (200 OK)
```json
{
  "url": "<Stripe Checkout Session URL>"
}
```

---

## ❗ Error Responses

| Status | Error Type                    | Message                                                                                         |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| 400    | Authentication Error          | Unauthorized (missing or invalid JWT, or missing `sub`/`email` in token)                        |
| 400    | Method Not Allowed            | Method Not Allowed (only POST and OPTIONS supported)                                            |
| 400    | Validation Error              | Missing `plan_type` or `plan_option` in request body                                           |
| 400    | Plan Conflict                 | Already on this plan or plan downgrade not allowed                                              |
| 401    | Unauthorized                  | Missing or invalid JWT payload                                                                  |
| 404    | User Not Found                | User not found in `users` table                                                                 |
| 404    | Price Not Found               | No matching `price_id` for given `plan_type`/`plan_option` in `token_prices` or `subscription_prices` |
| 500    | Database Read Error           | Error verifying current subscription or fetching price                                          |
| 500    | Internal Server Error         | Unexpected error creating Stripe session or other internal errors                                |

---

## ⚙️ Environment Variables (Edge Function)

```
STRIPE_SECRET_KEY=...             (Your Stripe secret key)
SUPABASE_URL=...                  (Your Supabase project URL)
SUPABASE_SERVICE_ROLE_KEY=...     (Service-role key for Supabase)
DOMAIN=...                        (Your frontend domain, e.g., https://example.com)
TELEGRAM_BOT_KEY=...              (Bot token for sending critical notifications)
TELEGRAM_CHAT_ID=...              (Telegram chat ID for notifications)
```

---

## ✅ Validation & Preflight Checks

| Check                                       | Status | Description                                                                                                      |
| ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Environment variable presence               | ✅     | Verifies `STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `DOMAIN` are set; fails early with Telegram notification if missing. |
| CORS preflight handling                     | ✅     | Handles `OPTIONS` request; returns 204 with appropriate CORS headers.                                             |
| JWT presence and decoding                   | ✅     | Verifies `Authorization` header exists; decodes JWT to extract `user_id` and `email`.                              |
| User existence in Supabase                  | ✅     | Queries `users` table by `user_id`; returns 404 if not found.                                                     |
| Request body fields                         | ✅     | Ensures both `plan_type` and `plan_option` are provided (returns 400 if missing).                                  |
| Active subscription check (for non-token)   | ✅     | If `plan_type !== "tokens"`, verifies no conflicting active subscription exists; returns 400 if conflict.         |
| Price lookup in correct table               | ✅     | Queries `token_prices` (if `plan_type === "tokens"`) or `subscription_prices`; returns 404 if not found.           |
| Stripe mode determination                   | ✅     | Sets `mode` to `"payment"` for one-time or `"subscription"` for recurring (non-token, non-daily) plans.           |
| Error handling & logging                    | ✅     | All errors are logged with `[create_checkout_session]` prefix; critical failures trigger Telegram notifications.  |
| CORS policy (temporary wildcard)            | ⚠️     | Currently allows all origins; should be locked down to specific domains in production.                            |

---

## 🔐 Security Measures

| Area                                      | Status | Description                                                                                                                    |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| JWT Verification & Authorization          | ✅     | Decodes JWT from `Authorization` header; rejects if missing `sub` or `email`.                                                    |
| Supabase Service Role Key usage           | ✅     | Uses service-role key only in Edge Function; never exposed to clients.                                                           |
| Table row existence checks                | ✅     | Verifies user exists and a valid price row is found; returns 404 otherwise.                                                     |
| Plan conflict logic                       | ✅     | Prevents downgrades or re-subscribing to same plan; enforces business rules at backend.                                         |
| Error handling & logging                  | ✅     | Errors are logged with clear prefix; returns generic 500 to client, avoiding sensitive details.                                 |
| CORS policy (temporary wildcard)          | ⚠️     | Currently allows all origins; should be locked down to specific domains in production.                                          |

---

## 📡 Internal Workflow & Logic

1. **CORS Preflight Handler**  
   - Respond to `OPTIONS` requests:  
     ```
     Status: 204 No Content  
     Headers:  
       Access-Control-Allow-Origin: *  
       Access-Control-Allow-Methods: POST, OPTIONS  
       Access-Control-Allow-Headers: Content-Type, Authorization  
     ```

2. **Authenticate & Decode JWT**  
   - Extract `Authorization` header (`Bearer <token>`).  
   - Decode token payload:  
     - `user_id = payload.sub`  
     - `email = payload.email`  
   - If missing or invalid, return 401 Unauthorized.

3. **Verify User Exists**  
   - Query `users` table:  
     ```sql
     SELECT id FROM users WHERE user_id = <user_id>
     ```  
   - If not found, return 404 "User not found".

4. **Parse Request Body**  
   - Expect JSON with `plan_type`, `plan_option`.  
   - If either field is missing, return 400 "Missing plan_type or plan_option".

5. **Active Subscription Check (Non-Token Plans)**  
   - If `plan_type !== "tokens"`:  
     - Query `subscriptions` for active subscription:  
       ```sql
       SELECT plan, billing_cycle FROM subscriptions 
       WHERE user_id = <user_id> AND is_active = true
       ```  
     - If error querying, return 500.  
     - If an active subscription exists:  
       - If `currentPlan === plan_option` and `currentCycle === plan_type`, return 400 "You already have this plan active".  
       - If `newIndex < currentIndex` (downgrade), return 400 "Cannot downgrade without canceling current plan".  
       - If `plan_type === "daily"` and an active subscription exists, return 400 "Cannot subscribe to the daily plan while another plan is active".

6. **Lookup Price ID**  
   - Determine `table = plan_type === "tokens" ? "token_prices" : "subscription_prices"`.  
   - Query:  
     ```sql
     SELECT price_id FROM <table> 
     WHERE plan_type = <plan_type> AND plan_option = <plan_option>
     ```  
   - If not found, return 404 "Price not found".

7. **Determine Stripe Mode**  
   - If `plan_type === "tokens"` or `plan_type === "daily"`, `stripeMode = "payment"` (one-time charge).  
   - Else, `stripeMode = "subscription"` (recurring).

8. **Create Stripe Checkout Session**  
   - Call `stripe.checkout.sessions.create` with:  
     ```js
     {
       mode: stripeMode,
       payment_method_types: ["card"],
       customer_email: email,
       line_items: [{ price: price_id, quantity: 1 }],
       success_url: `${DOMAIN}/success`,
       cancel_url: `${DOMAIN}/cancel`,
       metadata: { user_id, plan_type, plan_option },
       ...(stripeMode === "subscription" && {
         subscription_data: {
           metadata: { user_id, plan_type, plan_option }
         }
       })
     }
     ```  
   - On success, return JSON `{ url: session.url }` with 200 and CORS header.  
   - On Stripe or other errors, log `❌ Error creating Stripe session: <error>` and return 500 "Internal server error".

---

## 🛠 To Do for Production Readiness

| Task                                    | Status | Notes                                                                                              |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Lock down CORS origins                  | ⚠️     | Replace wildcard `*` with specific frontend domain(s) in both preflight and response headers.       |
| Use a robust JWT library                | ⚠️     | Replace manual `atob` decoding with a verified JWT library to validate signatures and expiration.  |
| Validate Stripe webhook signatures      | ⚠️     | Implement endpoint to handle Stripe webhooks and verify signatures for subscription events.         |
| Rate limiting & abuse prevention        | ⚠️     | Ensure the endpoint cannot be abused by automated requests; implement rate limiting at the edge.     |

---

*End of contract for the `create_checkout_session` Edge Function.*  
