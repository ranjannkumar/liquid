# Cancel Subscription Edge Function – Backend Contract

## ✅ Endpoint
```
POST /
Content-Type: application/json
Authorization: Bearer <JWT>
```

---

## 📥 Request Headers
- `Authorization: Bearer <JWT>`  
  - JWT must contain:
    - `sub` claim as `user_id`

- CORS:
  - `Access-Control-Allow-Origin: *` (temporary; adjust in production)
  - `Access-Control-Allow-Methods: POST, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type, Authorization`

---

## 🔁 Response (200 OK)
```json
{
  "message": "Subscription cancellation scheduled"
}
```

---

## ❗ Error Responses

| Status | Error Type                    | Message                                         |
| ------ | ----------------------------- | ----------------------------------------------- |
| 401    | Authentication Error          | Unauthorized                                    |
| 404    | Not Found                     | Active subscription not found                   |
| 405    | Method Not Allowed            | Method Not Allowed                              |
| 500    | Internal Server Error         | Internal server error                           |

---

## ⚙️ Environment Variables (Edge Function)

```
STRIPE_SECRET_KEY=...             (Your Stripe secret key)
SUPABASE_URL=...                  (Your Supabase project URL)
SUPABASE_SERVICE_ROLE_KEY=...     (Service-role key for Supabase)
TELEGRAM_BOT_KEY=...              (Bot token for sending critical notifications)
TELEGRAM_CHAT_ID=...              (Telegram chat ID for notifications)
```

---

## ✅ Validation & Preflight Checks

| Check                                 | Status | Description                                                                                                     |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| Environment variable presence         | ✅     | Verifies `STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` are set; fails early with Telegram notification if missing. |
| CORS preflight handling               | ✅     | Handles `OPTIONS` request; returns 204 with appropriate CORS headers.                                           |
| JWT presence and decoding             | ✅     | Verifies `Authorization` header exists; decodes JWT to extract `user_id`.                                       |
| Active subscription lookup            | ✅     | Queries `subscriptions` table for latest active subscription by `user_id`; returns 404 if not found.            |
| Stripe cancellation call              | ✅     | Calls Stripe API to set `cancel_at_period_end` for the subscription ID.                                         |
| Error handling & logging              | ✅     | All errors logged with `[cancel_subscription]` prefix; critical failures trigger Telegram notifications.         |

---

## 🔐 Security Measures

| Area                                    | Status | Description                                                                                                                  |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| JWT Verification & Authorization        | ✅     | Decodes JWT from `Authorization` header; rejects if missing `sub`.                                                            |
| Supabase Service Role Key usage         | ✅     | Uses service-role key only in Edge Function; never exposed to clients.                                                       |
| Table row existence checks              | ✅     | Verifies active subscription exists; returns 404 otherwise.                                                                  |
| Webhook signature verification           | ⚠️     | Not applicable (no Stripe signature here).                                                                                   |
| Error notifications via Telegram        | ✅     | On critical database or Stripe errors, sends a Telegram alert with error details (excluding sensitive data).                 |
| Least privilege principle               | ✅     | Edge Function only reads/writes specific rows in the database; no broad permissions.                                         |

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
   - If missing or invalid, return 401 Unauthorized.

3. **Find Active Subscription**  
   - Query `subscriptions` table:  
     ```sql
     SELECT stripe_subscription_id 
     FROM subscriptions 
     WHERE user_id = <user_id> AND is_active = true 
     ORDER BY created_at DESC 
     LIMIT 1
     ```  
   - If not found or error, return 404 "Active subscription not found".

4. **Schedule Cancellation in Stripe**  
   - Call `stripe.subscriptions.update(stripe_subscription_id, { cancel_at_period_end: true })`.  
   - On success, respond 200 `{ "message": "Subscription cancellation scheduled" }`.  
   - On Stripe error, return 500 "Internal server error".

5. **Unhandled Errors**  
   - Log with prefix `[cancel_subscription]`.  
   - Send Telegram notification for critical failures.  
   - Return 500 "Internal server error".

---

*End of contract for the `cancel_subscription` Edge Function.*  
