// deno test -A tests/normalize-interval.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

const norm = (i?: string) => i === "day" ? "daily" : i === "week" ? "weekly" : i === "year" ? "yearly" : "monthly";

Deno.test("normalizes stripe intervals", () => {
  assertEquals(norm("day"), "daily");
  assertEquals(norm("week"), "weekly");
  assertEquals(norm("month"), "monthly");
  assertEquals(norm("year"), "yearly");
});
