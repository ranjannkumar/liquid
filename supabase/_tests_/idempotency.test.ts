// deno test -A tests/idempotency.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

class FakeDB {
  seen = new Set<string>();
  insert(id: string) {
    if (this.seen.has(id)) throw new Error("duplicate");
    this.seen.add(id);
  }
}

function recordOnce(db: FakeDB, id: string): boolean {
  try {
    db.insert(id);
    return true;
  } catch (_e) {
    return false;
  }
}

Deno.test("recordOnce returns false on duplicates", () => {
  const db = new FakeDB();
  const first = recordOnce(db, "evt_1");
  const second = recordOnce(db, "evt_1");
  assertEquals(first, true);
  assertEquals(second, false);
});
