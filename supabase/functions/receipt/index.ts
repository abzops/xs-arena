// XS Arena — public receipt for the link a customer gets on WhatsApp (/r/<token>). No login.
// Reads one bill by its secret share token through _receipt_by_token (service role only).
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const token = new URL(req.url).searchParams.get('t') ?? '';
  if (!/^[a-f0-9]{32,128}$/.test(token)) return Response.json({ error: 'This receipt link is not valid.' }, { status: 404, headers: cors });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('_receipt_by_token', { p_token: token });
  if (error) return Response.json({ error: 'Could not load the receipt. Try again.' }, { status: 500, headers: cors });
  if (!data) return Response.json({ error: 'This receipt link is not valid.' }, { status: 404, headers: cors });
  return Response.json(data, { headers: { ...cors, 'Cache-Control': 'private, max-age=60' } });
});
