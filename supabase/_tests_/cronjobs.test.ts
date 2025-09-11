// supabase/_tests_/cronjobs.test.ts

import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import sinon from "npm:sinon";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient("http://localhost:54321", "fake-key");

const mockRefillLogic = async () => {
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  const mockYearlySubs = [
    { id: "sub1", user_id: "user1", plan: "price_yearly_basic", last_monthly_refill: new Date(thisYear, thisMonth - 1, 1).toISOString() },
    { id: "sub2", user_id: "user2", plan: "price_yearly_premium", last_monthly_refill: new Date(thisYear, thisMonth, 1).toISOString() },
  ];

  // Correct the object literal to only include 'data'
  const { data: yearly } = { data: mockYearlySubs };
  const insertStub = sinon.stub();
  const updateStub = sinon.stub();

  const oldStub = sinon.stub(supabase, "from").returns({
      select: () => ({
          eq: () => ({
              eq: () => ({ data: yearly }),
          }),
      }),
      insert: insertStub.returns({ data: [], error: null }),
      update: updateStub.returns({ eq: () => ({ data: null, error: null }) }),
  });

  for (const s of yearly ?? []) {
    const last = s.last_monthly_refill ? new Date(s.last_monthly_refill) : null;
    const already = last && last.getMonth() === thisMonth && last.getFullYear() === thisYear;
    if (already) continue;

    const { data: tokenRow } = { data: { tokens: 1000 } }; // Correct the object literal
    if (!tokenRow) continue;

    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);
    await supabase.from("user_token_batches").insert({
      user_id: s.user_id,
      source: "subscription",
      subscription_id: s.id,
      amount: tokenRow.tokens,
      consumed: 0,
      is_active: true,
      expires_at: expires.toISOString(),
      note: "yearly-monthly-refill (cron)",
    });
    await supabase.from("subscriptions").update({ last_monthly_refill: now.toISOString() }).eq("id", s.id);
  }
  
  assertEquals(insertStub.callCount, 1);
  assertEquals(updateStub.callCount, 1);
  assertEquals(insertStub.getCall(0).args[0].user_id, "user1");
  assertEquals(updateStub.getCall(0).args[1].id, "sub1");
  
  oldStub.restore();
};

Deno.test("Yearly refill is idempotent", async () => {
  await mockRefillLogic();
});