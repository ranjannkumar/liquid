// supabase/functions/token_service/index.ts
// This is a new file to address T10
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "token_service";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// supabase/functions/token_service/index.ts

async function consumeTokens(user_id: string, amount: number, reason: string): Promise<number> {
  const { data: batches, error } = await supabase
    .from("user_token_batches")
    .select("id, consumed, available, expires_at") // Add 'consumed' to the select statement
    .eq("user_id", user_id)
    .eq("is_active", true)
    .gt("available", 0)
    .order("expires_at", { ascending: true });

  if (error || !batches) {
    throw new Error("Failed to fetch batches.");
  }

  let remaining = amount;
  for (const batch of batches) {
    const consumption = Math.min(remaining, batch.available);
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
}


serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const { user_id, amount, reason } = await req.json();

  if (!user_id || !amount || !reason) {
    return new Response("Missing parameters", { status: 400 });
  }

  try {
    const consumed = await consumeTokens(user_id, amount, reason);
    return new Response(JSON.stringify({ consumed }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: unknown) {
    if (e instanceof Error) {
      return new Response(e.message, { status: 500 });
    }
    return new Response("Unknown error", { status: 500 });
  }
});