import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * The Supabase client.
 *
 * Only the anon key ships here, and that is by design — it is public, and Row
 * Level Security is what makes it safe. If you ever find yourself reaching for
 * the service_role key in this file, stop: that key bypasses every policy in
 * 002_rls.sql, and this bundle is trivially extractable from a shipped IPA.
 * Anything needing server authority goes in an edge function.
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill them in.'
  );
}

/**
 * Tokens live in the Keychain / Keystore, never in AsyncStorage.
 *
 * AsyncStorage is plaintext on disk and readable on a rooted or jailbroken
 * device — and a stolen phone with a live session is threat #2 in
 * Trucktags/docs/SECURITY.md.
 *
 * SecureStore rejects values over 2048 bytes on some devices, so a large
 * session gets split across numbered chunks.
 */
const CHUNK_LIMIT = 2000;

const SecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(key);
    if (head === null) return null;
    if (!head.startsWith('__chunked__:')) return head;

    const count = Number(head.slice('__chunked__:'.length));
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part === null) return null; // a torn write; treat as signed out
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    await this.removeItem(key);

    if (value.length <= CHUNK_LIMIT) {
      await SecureStore.setItemAsync(key, value);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_LIMIT) {
      chunks.push(value.slice(i, i + CHUNK_LIMIT));
    }
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, chunks[i]!);
    }
    await SecureStore.setItemAsync(key, `__chunked__:${chunks.length}`);
  },

  async removeItem(key: string): Promise<void> {
    const head = await SecureStore.getItemAsync(key);
    if (head?.startsWith('__chunked__:')) {
      const count = Number(head.slice('__chunked__:'.length));
      for (let i = 0; i < count; i++) {
        await SecureStore.deleteItemAsync(`${key}.${i}`);
      }
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: SecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // There is no URL to parse a session out of on a native client, and
    // leaving this on makes the SDK poke at window.location.
    detectSessionInUrl: false,
  },
  global: {
    headers: {
      'x-tagsnap-client': `mobile/${Platform.OS}`,
    },
  },
});

/** Base URL for edge functions, derived from the project URL. */
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
