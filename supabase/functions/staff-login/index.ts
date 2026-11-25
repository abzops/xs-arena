// XS Arena — Edge Function /functions/v1/staff-login (same design as XS Gym)
//   POST { action: 'create', centre_id, staff_id } → { username, password, name, phone, role }
//   POST { action: 'reset',  centre_id, staff_id } → { username, password, name, phone, role }
//
// The owner makes a login for a team member: a username + password, no email or sign-up.
// Every permission check runs in the database as the signed-in owner
// (prepare_staff_login / attach_staff_login / prepare_staff_password_reset, migration 0025).
// The service key is used only to create the auth account or set its password, after that check.
// Passwords are generated here, returned once to the owner and never stored or logged by XS Arena.

const ALLOWED_ORIGINS = ['https://arena.xelorsoft.com', 'http://localhost:5173', 'http://localhost:4173'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const env = (k: string) => { try { return Deno.env.get(k)?.trim() || undefined; } catch { return undefined; } };

/** Easy to read out and type on a phone: no 0/O, 1/l/I. e.g. "k7Qm-x3Fp". */
export function generatePassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz', upper = 'ABCDEFGHJKMNPQRSTUVWXYZ', digits = '23456789';
  const all = lower + upper + digits;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    // 54 characters; 216 = 54 * 4, so bytes ≥ 216 are skipped to keep every character equally likely.
    const chars: string[] = [];
    for (const b of bytes) if (b < 216) chars.push(all[b % all.length]);
    if (chars.length < 8) continue;
    const pw = chars.join('');
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[2-9]/.test(pw)) return `${pw.slice(0, 4)}-${pw.slice(4)}`;
  }
}

function errorFrom(body: unknown, fallback: string): string {
  const b = body as { message?: string; msg?: string; error_description?: string; error?: string } | null;
  return b?.message ?? b?.msg ?? b?.error_description ?? (typeof b?.error === 'string' ? b.error : undefined) ?? fallback;
}

async function rpcAsUser<T>(fn: string, args: Record<string, unknown>, token: string, apikey: string): Promise<T> {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = errorFrom(body, 'Request failed');
    // The database's own messages are written for owners ("Reactivate this team member first"); pass them on.
    if (/permission denied|not allowed|JWT/i.test(msg)) throw new ApiError('You do not have permission to do this', 403);
    throw new ApiError(res.status >= 500 ? 'Could not save. Please try again.' : msg, res.status >= 500 ? 500 : 400);
  }
  return body as T;
}

async function admin(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new ApiError('Staff logins are not set up on the server yet.', 503);
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/admin/users${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = errorFrom(out, `auth ${res.status}`);
    console.error('staff-login auth admin', method, res.status, msg.slice(0, 200));
    if (/already|exists|registered/i.test(msg)) throw new ApiError('That username was just taken. Please try again.', 409);
    throw new ApiError('The login could not be created. Please try again.', 502);
  }
  return out as Record<string, unknown>;
}

type Prepared = { username: string; email: string; name: string; phone: string | null; role: string };
type ResetTarget = { user_id: string; username: string; name: string; phone: string | null; role: string };

function ids(b: Record<string, unknown>) {
  const centre = String(b.centre_id ?? ''), staff = String(b.staff_id ?? '');
  if (!UUID.test(centre) || !UUID.test(staff)) throw new ApiError('Team member is missing', 400);
  return { centre, staff };
}

async function createLogin(b: Record<string, unknown>, token: string, apikey: string) {
  const { centre, staff } = ids(b);
  // 1. Permission + team-row checks as the owner; also picks the username.
  const p = await rpcAsUser<Prepared>('prepare_staff_login', { p_centre: centre, p_staff: staff }, token, apikey);
  // 2. Create the account, already confirmed. app_metadata can only be set with the service key.
  const password = generatePassword();
  const user = await admin('POST', '', {
    email: p.email, password, email_confirm: true,
    user_metadata: { display_name: p.name },
    app_metadata: { xs_staff_centre: centre, xs_staff_row: staff, xs_staff_login: true },
  });
  const userId = String(user.id ?? '');
  // 3. Link it to the team row as the owner (audited). Undo the account if that fails.
  try {
    await rpcAsUser('attach_staff_login', { p_centre: centre, p_staff: staff, p_user: userId, p_username: p.username }, token, apikey);
    console.log('staff-login created', centre, p.role);
    return { username: p.username, password, name: p.name, phone: p.phone, role: p.role };
  } catch (e) {
    await admin('DELETE', `/${userId}`).catch(() => console.error('staff-login rollback failed', userId));
    throw e;
  }
}

async function resetPassword(b: Record<string, unknown>, token: string, apikey: string) {
  const { centre, staff } = ids(b);
  const t = await rpcAsUser<ResetTarget>('prepare_staff_password_reset', { p_centre: centre, p_staff: staff }, token, apikey);
  const password = generatePassword();
  await admin('PUT', `/${t.user_id}`, { password });
  console.log('staff-login reset', centre);
  return { username: t.username, password, name: t.name, phone: t.phone, role: t.role };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const cors = {
    'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  // Passwords in responses must never be cached anywhere.
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  try {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const apikey = req.headers.get('apikey') ?? env('SUPABASE_ANON_KEY') ?? '';
    if (!token || !apikey) throw new ApiError('Sign in required', 401);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { throw new ApiError('Request body must be JSON', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('Request body must be a JSON object', 400);
    if (body.action === 'create') return json(200, await createLogin(body, token, apikey));
    if (body.action === 'reset') return json(200, await resetPassword(body, token, apikey));
    throw new ApiError('Unknown action', 400);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (!(e instanceof ApiError)) console.error('staff-login', e instanceof Error ? e.message : e);
    return json(status, { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' });
  }
});
