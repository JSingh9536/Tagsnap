import { createClient } from '@supabase/supabase-js';

/**
 * The office console's Supabase client.
 *
 * Same anon key as the mobile app, same RLS underneath. What differs is who
 * signs in: only office and admin roles get past the gate in state/auth.tsx,
 * and those accounts carry mandatory MFA because they are the ones that can
 * move money.
 */

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!URL || !ANON) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.'
  );
}

export const supabase = createClient(URL, ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Office sessions are short. A reviewer's browser left open on a shared
    // desk is the desk-bound version of a lost phone.
    storageKey: 'tagsnap-office',
  },
});

export const FUNCTIONS_URL = `${URL}/functions/v1`;

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
