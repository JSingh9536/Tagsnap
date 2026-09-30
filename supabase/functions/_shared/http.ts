/**
 * Shared plumbing for the edge functions.
 *
 * Every function in this directory holds server-side authority — the Claude
 * key, the Google service account, the service_role key. None of that may ever
 * exist in the mobile bundle, so these are the only place it lives, and they
 * authenticate the caller before touching any of it.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  // The mobile app sends no Origin, so a missing one is fine. A browser
  // origin has to be on the list — the office console is the only web caller.
  const allow =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? '';

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(
  body: unknown,
  status: number,
  origin: string | null
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('Origin')),
  });
}

export interface Caller {
  userId: string;
  role: 'driver' | 'subhauler' | 'office' | 'admin';
  companyId: string;
  subhaulerId: string | null;
  /** Scoped to the caller — every query through it still goes through RLS. */
  asUser: SupabaseClient;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * The service-role client. Bypasses every policy in 002_rls.sql, so it is only
 * ever used for work the caller has already been authorised to trigger.
 */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Identify the caller from their bearer token, or fail. */
export async function authenticate(req: Request): Promise<Caller> {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing authorization.');
  }

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: auth, error } = await asUser.auth.getUser();
  if (error || !auth.user) throw new HttpError(401, 'Not signed in.');

  const { data: profile } = await serviceClient()
    .from('profiles')
    .select('role, company_id, subhauler_id, active')
    .eq('id', auth.user.id)
    .single();

  if (!profile || !profile.active) {
    throw new HttpError(403, 'This account is not active.');
  }

  return {
    userId: auth.user.id,
    role: profile.role,
    companyId: profile.company_id,
    subhaulerId: profile.subhauler_id,
    asUser,
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function handleError(err: unknown, origin: string | null): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status, origin);
  }
  // Never echo an internal error to a client — it leaks schema and key names.
  console.error('unhandled', err);
  return json({ error: 'Something went wrong.' }, 500, origin);
}

/**
 * Record this call and refuse it if the caller is over their hourly limit.
 *
 * The extraction endpoint calls a paid API, so it needs a limit independent of
 * whether the request is correct. A normal driver files 10-20 tags a day;
 * anything past this is a bug or abuse, and either way it should stop before
 * it produces a surprise invoice.
 *
 * Recording happens first, and in the same statement as the count — see
 * record_usage() in 006. Counting and then recording leaves a window where two
 * concurrent requests both see a count under the limit and both proceed.
 */
export async function checkQuota(
  caller: Caller,
  action: string,
  perHour: number
): Promise<void> {
  const { data, error } = await serviceClient().rpc('record_usage', {
    p_actor: caller.userId,
    p_company: caller.companyId,
    p_action: action,
    p_window_minutes: 60,
  });

  // A metering failure must not take the endpoint down with it, but it must
  // be loud — an unmetered paid endpoint is how a bill runs away.
  if (error) {
    console.error('quota metering failed', error);
    return;
  }

  if ((data as number) > perHour) {
    throw new HttpError(429, 'Too many requests in the last hour.');
  }
}

/** Close out the usage row this call opened, so the spend view is accurate. */
export async function finishQuota(
  caller: Caller,
  action: string,
  ok: boolean,
  detail?: unknown
): Promise<void> {
  await serviceClient()
    .rpc('finish_usage', {
      p_actor: caller.userId,
      p_action: action,
      p_ok: ok,
      p_detail: detail ?? null,
    })
    .then(
      () => undefined,
      () => undefined // metering, not correctness
    );
}

/**
 * Is this call coming from the database rather than from a person?
 *
 * The triggers in 007_automation.sql post with the service role key as the
 * bearer token. Nothing else legitimately calls those endpoints, and the
 * gateway cannot make this distinction for us — `verify_jwt` is satisfied by
 * any valid key for the project, and the publishable key is compiled into
 * every copy of both mobile apps.
 *
 * Constant-time comparison. A naive `===` on a secret leaks its length and, in
 * principle, its prefix through response timing. The cost of doing it properly
 * is four lines.
 */
export function isServiceRole(req: Request): boolean {
  const header = req.headers.get('Authorization') ?? '';
  const presented = header.replace(/^Bearer\s+/i, '').trim();
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (expected.length === 0) {
    // Unset means misconfigured, not "allow everything". Fail closed and say
    // so in the log, because the symptom otherwise is notifications silently
    // never arriving.
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set; refusing every call');
    return false;
  }

  return timingSafeEqual(presented, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  // Compare lengths without branching out early, then every byte regardless of
  // whether a mismatch has already been found.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
