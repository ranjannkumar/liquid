# Monthly Subscription Tasks Edge Function – Backend Contract

## ✅ Invocation
This function is invoked by a scheduler (no manual HTTP request required). It runs with private permissions.

---

## 🔁 Response (200 OK)
```
<plain text>
✅ {deactivatedCount} subscription(s) deactivated, {tokensRefilledCount} token batch(es) added.
</plain text>
```

---

## ❗ Error Responses

| Status | Error Type                    | Message                                                              |
| ------ | ----------------------------- | -------------------------------------------------------------------- |
| 500    | Database Read Error           | ❌ Error fetching expired token batches                               |
| 500    | Database Read Error           | ❌ Error fetching active subscriptions                                 |
| 500    | Database Read Error           | ❌ Error fetching yearly subscriptions                                 |
| 500    | Token Lookup Error            | ❌ Token amount lookup failed for plan `<plan_option>`                 |
| 500    | Database Update Error         | ⚠️ Failed to deactivate token batch `<batch_id>`                       |
| 500    | Database Update Error         | ⚠️ Failed to deactivate subscription `<sub_id>`                        |
| 500    | Database Update Error         | ⚠️ Failed to update user flag for `<user_id>`                           |
| 500    | Database Update Error         | ⚠️ Failed to insert token batch or update subscription `<sub_id>`       |
| 500    | Missing Environment Variables | ❌ Missing required environment variables (SUPABASE_URL or SERVICE_ROLE) |

---

## ⚙️ Environment Variables (Edge Function)

```
SUPABASE_URL=...               (Your Supabase project URL)
SUPABASE_SERVICE_ROLE_KEY=...  (Service-role key for server-side operations)
TELEGRAM_BOT_KEY=...           (Bot token for sending critical notifications)
TELEGRAM_CHAT_ID=...           (Telegram chat ID for notifications)
```

---

## ✅ Validation & Preflight Checks

| Check                                 | Status | Description                                                                                                      |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Environment variable presence         | ✅     | Verifies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set; fails early with Telegram notification if missing. |
| Supabase client initialization        | ✅     | Uses service-role key only on the server-side; never exposed to clients.                                          |

---

## 🔐 Security Measures

| Area                                           | Status | Description                                                                                                                                    |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler-only invocation                      | ✅     | Function is marked `permissions: "private"`, ensuring only internal scheduler can trigger it.                                                   |
| Supabase Service Role Key usage                 | ✅     | Uses service-role key exclusively in Edge Function; never returned to any client.                                                              |
| Error handling & logging                        | ✅     | All errors are logged with `[monthly_subscription_tasks]` prefix; critical failures trigger Telegram notifications.                               |
| Least privilege principle                       | ✅     | No client-facing credentials are exposed.                                                                                                       |
| Rate limiting (DoS protection)                  | ⚠️     | Not applicable, as this runs on a fixed schedule rather than external requests.                                                                |
| CORS policy                                     | ⚠️     | Not required (no public endpoint).                                                                                                              |

---

## 📡 Internal Workflow & Logic

1. **Mark Expired Token Batches as Inactive**
   - Query `user_token_batches` where `is_active = true` and `expires_at < now`.
   - For each expired batch, update `is_active = false`.
   - Logs (per batch):  
     ```
     [monthly_subscription_tasks] 🔍 Found N expired token batch(es).
     [monthly_subscription_tasks] ✅ Marked batch <batch_id> as inactive.
     [monthly_subscription_tasks] ⚠️ Failed to deactivate batch <batch_id>: <error_message>
     ```

2. **Deactivate Expired Subscriptions**
   - Query `subscriptions` where `is_active = true`.
   - If `current_period_end < now`, update `is_active = false` and collect `user_id`.
   - After deactivating, set `users.has_active_subscription = false` for each affected `user_id`.
   - Logs:  
     ```
     [monthly_subscription_tasks] 🔍 Retrieved M active subscription(s).
     [monthly_subscription_tasks] 🛑 Subscription expired for user <user_id> (sub_id: <sub_id>).
     [monthly_subscription_tasks] ⚠️ Failed to deactivate subscription <sub_id>: <error_message>
     [monthly_subscription_tasks] ✅ Cleared active subscription flag for user <user_id>.
     [monthly_subscription_tasks] ⚠️ Failed to update user <user_id> flag: <error_message>
     ```

3. **Refill Monthly Tokens for Active Yearly Subscriptions**
   - Query `subscriptions` where `billing_cycle = "yearly"` and `is_active = true`.
   - For each subscription:
     - If `last_monthly_refill` is already in the current year & month, skip.
     - Otherwise:
       1. Fetch monthly token amount from `subscription_prices` where `plan_option = <plan>` and `plan_type = "yearly"`.
          - Error if missing or invalid.
       2. Insert a new row into `user_token_batches`:
          ```jsonc
          {
            "user_id": <user_id>,
            "source": "subscription",
            "subscription_id": <sub_id>,
            "amount": <tokens_amount>,
            "consumed": 0,
            "expires_at": <one_month_from_now>,
            "is_active": true
          }
          ```
       3. Update `subscriptions.last_monthly_refill = now`.
     - Logs:  
       ```
       [monthly_subscription_tasks] 🔍 Retrieved P active yearly subscription(s).
       [monthly_subscription_tasks] ℹ️ Subscription <sub_id> already refilled for <YYYY-MM>.
       [monthly_subscription_tasks] 🔢 Retrieved <tokens_amount> tokens/month for plan <plan_option>.
       [monthly_subscription_tasks] 🎁 Issued <tokens_amount> tokens to user <user_id> (sub_id: <sub_id>).
       [monthly_subscription_tasks] ⚠️ Skipping refill for subscription <sub_id> due to token lookup error.
       [monthly_subscription_tasks] ⚠️ Failed to insert token batch or update subscription <sub_id>: <error_message>
       ```

4. **Return Summary Response**
   - HTTP 200 with plain-text body:
     ```
     ✅ {deactivatedCount} subscription(s) deactivated, {tokensRefilledCount} token batch(es) added.
     ```

---

## 🛠 To Do for Production Readiness

| Task                                    | Status | Notes                                                                                                      |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |

---

## 🔧 Scheduler Configuration

- **Frequency:** Run once per day (e.g., at 00:05 UTC) to catch any expirations.  
- **Platform Example (e.g., Vercel Cron):**  
  ```
  5 0 * * * curl -X POST https://<your-domain>/api/monthly_subscription_tasks
  ```

---


*End of contract for the `monthly_subscription_tasks` Edge Function.*  
