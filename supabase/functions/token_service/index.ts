// supabase/functions/token_service/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EDGE_FUNCTION_NAME = "token_service";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function consumeTokens(user_id: string, amount: number, reason: string): Promise<number> {
  const { data: batches, error } = await supabase
    .from("user_token_batches")
    .select("id, consumed, consumed_pending, amount, expires_at")
    .eq("user_id", user_id)
    .eq("is_active", true)
    .order("expires_at", { ascending: true });

  if (error || !batches) {
    throw new Error("Failed to fetch batches.");
  }

  let remaining = amount;
  
  // Use a transaction for atomicity
  const { error: txError } = await supabase.rpc('start_transaction');
  if (txError) throw txError;
  
  try {
    for (const batch of batches) {
      const available = batch.amount - batch.consumed - batch.consumed_pending;
      const consumption = Math.min(remaining, available);
      if (consumption > 0) {
        // Tentatively consume tokens by updating consumed_pending
        const { error: updateError } = await supabase.from("user_token_batches")
          .update({ consumed_pending: batch.consumed_pending + consumption })
          .eq("id", batch.id);
        if (updateError) throw updateError;
        
        remaining -= consumption;
      }
      if (remaining === 0) break;
    }
    
    // If successful, commit the transaction and finalize consumption
    await supabase.rpc('commit_transaction');
    
    // Now, move pending to consumed and log
    const finalConsumed = amount - remaining;
    await supabase.rpc('finalize_consumption', {
      user_id,
      amount: finalConsumed,
      reason
    });
    
    return finalConsumed;
    
  } catch (e: unknown) {
    await supabase.rpc('rollback_transaction');
    throw e;
  }
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