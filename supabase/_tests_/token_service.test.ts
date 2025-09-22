// supabase/_tests_/token_service.test.ts
// New file to test T10
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import sinon from "npm:sinon";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient("http://localhost:54321", "fake-key");

const mockBatches = [
  { id: "batch-1", amount: 10, consumed: 0, expires_at: new Date(Date.now() + 1000).toISOString() },
  { id: "batch-2", amount: 50, consumed: 0, expires_at: new Date(Date.now() + 5000).toISOString() },
  { id: "batch-3", amount: 30, consumed: 0, expires_at: new Date(Date.now() + 2000).toISOString() },
];

const mockConsumeTokens = async (user_id: string, amount: number, reason: string): Promise<number> => {
  const { data: batches } = await supabase.from("user_token_batches")
    .select("id, consumed, amount, expires_at")
    .eq("user_id", user_id)
    .order("expires_at", { ascending: true });

  let remaining = amount;
  for (const batch of batches || []) {
    const available = batch.amount - batch.consumed;
    const consumption = Math.min(remaining, available);
    if (consumption > 0) {
      await supabase.from("user_token_batches")
        .update({ consumed: batch.consumed + consumption })
        .eq("id", batch.id);

      await supabase.from("token_event_logs").insert({
        user_id,
        batch_id: batch.id,
        delta: -consumption,
        reason,
      });

      remaining -= consumption;
    }
    if (remaining === 0) break;
  }
  return amount - remaining;
};


Deno.test("FIFO across batches prefers earliest expiry", async () => {
  const fromStub = sinon.stub(supabase, "from");
  const updateStub = sinon.stub();
  const insertStub = sinon.stub();
  
  // Sort the mock batches correctly by expiry date
  const sortedBatches = [
    mockBatches[0], // batch-1 (expires in 1s)
    mockBatches[2], // batch-3 (expires in 2s)
    mockBatches[1], // batch-2 (expires in 5s)
  ];

  // Correctly mock the chained calls
  const eqStub = sinon.stub().returns({ data: null, error: null });
  updateStub.returns({ eq: eqStub });

  fromStub.withArgs("user_token_batches").returns({
    select: sinon.stub().returns({
      eq: sinon.stub().returns({
        order: sinon.stub().returns({
          data: sortedBatches,
          error: null,
        }),
      }),
    }),
    update: updateStub,
  });

  fromStub.withArgs("token_event_logs").returns({
    insert: insertStub.returns({ data: null, error: null }),
  });

  const consumed = await mockConsumeTokens("test-user-id", 40, "api_call");
  
  assertEquals(consumed, 40);
  assertEquals(updateStub.callCount, 2);
  assertEquals(insertStub.callCount, 2);

  // Assertions for the first batch update (batch-1)
  assertEquals(updateStub.getCall(0).args[0].consumed, 10);
  assertEquals(eqStub.getCall(0).args[1], "batch-1");

  // Assertions for the second batch update (batch-3)
  assertEquals(updateStub.getCall(1).args[0].consumed, 30);
  assertEquals(eqStub.getCall(1).args[1], "batch-3");
  
  fromStub.restore();
});