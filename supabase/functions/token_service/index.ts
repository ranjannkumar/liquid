// supabase/functions/token_service/index.ts

import { serve } from "https://deno.land/std/http/server.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";



const EDGE_FUNCTION_NAME = "token_service";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;



const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);



/**

 * Consumes tokens atomically using a database RPC.

 * This replaces the flawed client-side transaction logic.

 */

async function consumeTokens(user_id: string, amount: number, reason: string): Promise<number> {

  const { data, error } = await supabase.rpc('consume_tokens', {

    p_user_id: user_id,

    p_amount: amount,

    p_reason: reason

  });



  if (error) {

    console.error(`[${EDGE_FUNCTION_NAME}] RPC call failed:`, error);

    throw new Error(`Token consumption failed: ${error.message}`);

  }

 

  return data;

}



serve(async (req) => {

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

 

  let user_id: string, amount: number, reason: string;

  try {

    const body = await req.json();

    user_id = body.user_id;

    amount = body.amount;

    reason = body.reason;

  } catch (e) {

    return new Response("Invalid JSON body", { status: 400 });

  }



  if (!user_id || typeof amount !== 'number' || !reason) {

    return new Response("Missing or invalid parameters", { status: 400 });

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