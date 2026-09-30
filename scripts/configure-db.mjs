#!/usr/bin/env node
/**
 * Tell the database where the edge functions live.
 *
 * Two rows in `app_config`, and without them nothing moves: a photo uploads,
 * the tag sits at "Sent", and no error appears anywhere because the trigger
 * politely declines to fire when it has no URL to call.
 *
 * Reads from supabase/.env, so run scripts/setup-local.mjs first — or set the
 * three variables yourself when pointing at a hosted project.
 *
 * For production, run this once against the hosted project with:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/configure-db.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function env() {
  const out = { ...process.env };
  const file = join(root, 'supabase/.env');

  // Real environment variables win, so a production run does not accidentally
  // pick up local development keys sitting in the repo.
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

async function main() {
  const e = env();
  const url = e.SUPABASE_URL;
  const key = e.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      '\n  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
        '  Run `npm run setup` first, or set them in your shell.\n'
    );
    process.exit(1);
  }

  // The URL the *database* uses to reach the functions. On the hosted stack
  // that is the public functions domain. Locally the database runs inside
  // Docker, so it cannot use 127.0.0.1 — that would be the container itself.
  const isLocal = url.includes('127.0.0.1') || url.includes('localhost');
  const functionsUrl = e.FUNCTIONS_URL
    ? e.FUNCTIONS_URL
    : isLocal
      ? 'http://host.docker.internal:54321/functions/v1'
      : `${url.replace(/\/$/, '')}/functions/v1`;

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supabase.from('app_config').upsert(
    [
      { key: 'functions_url', value: functionsUrl, updated_at: new Date().toISOString() },
      { key: 'service_role_key', value: key, updated_at: new Date().toISOString() },
    ],
    { onConflict: 'key' }
  );

  if (error) {
    console.error(`\n  Could not write app_config: ${error.message}`);
    console.error('  Have the migrations been applied? Try `npm run db:reset`.\n');
    process.exit(1);
  }

  console.log('');
  console.log(`  Database will call functions at:  ${functionsUrl}`);
  console.log('  Push notifications are now wired.');
  console.log('  (Reading tickets needs nothing here — it runs on the phone.)');
  console.log('');

  if (isLocal) {
    console.log(
      '  Note: locally this only works while `npm run functions` is running.\n' +
        '  If a tag stays on "Sent", that is almost always the reason.\n'
    );
  }
}

main();
