-- Enable safe UPSERTs and idempotency

alter table public.subscriptions
  add constraint subscriptions_stripe_subscription_id_key
  unique (stripe_subscription_id);

alter table public.user_token_purchases
  add constraint user_token_purchases_stripe_purchase_id_key
  unique (stripe_purchase_id);
