// deno test -A tests/fifo.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

type Batch = { id: string; amount: number; consumed: number; expires_at: Date };
const fifoSpend = (batches: Batch[], spend: number) => {
  // earliest expiry first, skip expired
  const now = new Date();
  const sorted = batches
    .filter(b => b.expires_at > now)
    .sort((a, b) => +a.expires_at - +b.expires_at);
  let left = spend;
  for (const b of sorted) {
    const avail = b.amount - b.consumed;
    const take = Math.min(avail, left);
    b.consumed += take;
    left -= take;
    if (!left) break;
  }
  return { spent: spend - left, batches };
};

Deno.test("FIFO across batches prefers earliest expiry", () => {
  const b1 = { id: "old", amount: 100, consumed: 0, expires_at: new Date(Date.now() + 1e5) };
  const b2 = { id: "new", amount: 100, consumed: 0, expires_at: new Date(Date.now() + 5e5) };
  const res = fifoSpend([b2, b1], 30);
  assertEquals(res.batches.find(b => b.id === "old")!.consumed, 30);
});
