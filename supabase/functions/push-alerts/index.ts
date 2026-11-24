// XS Arena — sends due "time almost up / time's up" alerts to staff phones (web push).
// Called every minute by pg_cron (see migration 0019). Safe to call more often: each alert is claimed once in the database.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

type Due = { kind: string; title: string; body: string; tag: string; url: string; endpoint: string; p256dh: string; auth: string };

Deno.serve(async () => {
  const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!pub || !priv) return new Response('VAPID keys not set', { status: 500 });
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:support@xelorsoft.com', pub, priv);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('_due_push_alerts');
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0, dropped = 0, failed = 0;
  await Promise.all((data as Due[] ?? []).map(async (a) => {
    try {
      await webpush.sendNotification(
        { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        JSON.stringify({ title: a.title, body: a.body, tag: a.tag, url: a.url }),
        { TTL: 300, urgency: 'high' },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await db.rpc('_drop_push_endpoint', { p_endpoint: a.endpoint }); dropped++; }
      else failed++;
    }
  }));
  return Response.json({ sent, dropped, failed });
});
