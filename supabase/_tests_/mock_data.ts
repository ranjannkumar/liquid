// supabase/_tests_/mock_data.ts

export const MOCK_USER = {
  user_id: "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6",
  email: "test@example.com",
};

export function createMockStripeEvent(eventType: string, data: object): any {
  return {
    id: `evt_${Math.random().toString(36).substring(2)}`,
    object: "event",
    api_version: "2022-11-15",
    created: Date.now() / 1000,
    data: {
      object: data,
    },
    livemode: false,
    pending_webhooks: 0,
    request: {
      id: null,
      idempotency_key: null,
    },
    type: eventType,
  };
}

export const MOCK_STRIPE_CUSTOMER = {
    id: "cus_123456789",
    object: "customer",
    email: MOCK_USER.email,
    metadata: {},
};

export const MOCK_STRIPE_SUBSCRIPTION = {
    id: "sub_123456789",
    object: "subscription",
    status: "active",
    items: {
        data: [{
            price: {
                id: "price_monthly_basic",
                nickname: "basic",
                recurring: { interval: "month" }
            }
        }]
    },
    metadata: { user_id: MOCK_USER.user_id }
};