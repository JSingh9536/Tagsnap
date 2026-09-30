#!/usr/bin/env node
/**
 * One-command setup.
 *
 * Works two ways, and figures out which on its own:
 *
 *   HOSTED  — a project at supabase.com. No Docker needed. Set SUPABASE_URL,
 *             SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in your shell
 *             and run this.
 *   LOCAL   — the stack `supabase start` runs on your machine. Needs Docker.
 *
 * Either way it writes the three .env files and tells you what to do next.
 *
 * Safe to re-run. Everything it writes is overwritten, not appended.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const config = hostedFromEnv() ?? localFromCli();

  if (!config) {
    fail(
      'Could not work out which Supabase to point at.\n\n' +
        '  HOSTED (no Docker) — create a free project at supabase.com, then:\n' +
        '    Project Settings -> API gives you the URL and both keys.\n\n' +
        '    PowerShell:\n' +
        '      $env:SUPABASE_URL = "https://xxxx.supabase.co"\n' +
        '      $env:SUPABASE_ANON_KEY = "eyJ..."\n' +
        '      $env:SUPABASE_SERVICE_ROLE_KEY = "eyJ..."\n' +
        '      npm run setup\n\n' +
        '  LOCAL (needs Docker) — run `npx supabase start` first, then re-run this.'
    );
  }

  const { apiUrl, anonKey, serviceKey, mode } = config;

  // A phone cannot reach your laptop's loopback address, so the native apps
  // get the LAN address instead. Only relevant locally — a hosted URL is
  // already reachable from anywhere.
  let mobileUrl = apiUrl;
  let lan = null;
  if (mode === 'local') {
    lan = lanAddress();
    if (lan) mobileUrl = apiUrl.replace('127.0.0.1', lan).replace('localhost', lan);
  }

  // The native apps read their config from build files rather than from a
  // dotenv, because that is how Xcode and Gradle work. Written here anyway so
  // that a local setup does not require anyone to hand-copy a LAN address into
  // two places and get one of them wrong.
  write('ios/Config.xcconfig', [
    '// Written by scripts/setup-local.mjs. Safe to edit; re-running overwrites.',
    '// TAGSNAP_TEAM_ID and TAGSNAP_BUNDLE_ID are yours to fill in — see ios/README.md.',
    // `//` starts a comment in an xcconfig, so the empty interpolation breaks
    // up the `//` in `https://` without changing the value.
    `SUPABASE_URL = ${mobileUrl.replace('//', '/$()/')}`,
    `SUPABASE_ANON_KEY = ${anonKey}`,
    `TAGSNAP_TEAM_ID = ${existingValue('ios/Config.xcconfig', 'TAGSNAP_TEAM_ID') || 'ABCDE12345'}`,
    `TAGSNAP_BUNDLE_ID = ${existingValue('ios/Config.xcconfig', 'TAGSNAP_BUNDLE_ID') || 'com.tagsnap.field'}`,
  ]);

  write('android/local.properties', [
    '# Written by scripts/setup-local.mjs. Safe to edit; re-running overwrites.',
    ...(existingValue('android/local.properties', 'sdk.dir')
      ? [`sdk.dir=${existingValue('android/local.properties', 'sdk.dir')}`]
      : []),
    `SUPABASE_URL=${mobileUrl}`,
    `SUPABASE_ANON_KEY=${anonKey}`,
  ]);

  write('apps/web/.env', [
    '# Written by scripts/setup-local.mjs. Safe to edit; re-running overwrites.',
    `VITE_SUPABASE_URL=${apiUrl}`,
    `VITE_SUPABASE_ANON_KEY=${anonKey}`,
  ]);

  // Push credentials are kept across a re-run rather than blanked. There is no
  // AI key to preserve any more — reading happens on the phone, for nothing.
  const keep = (name) => existingValue('supabase/.env', name) || process.env[name] || '';

  // Two files, because they are consumed by two different things and one of
  // them rejects half the contents of the other.
  //
  //   .env         everything, for `supabase functions serve --env-file`
  //                when running the functions locally
  //   .env.secrets only the deployable ones, for `supabase secrets set`
  //
  // The split is not tidiness. Supabase refuses any secret whose name starts
  // with `SUPABASE_` — the platform injects SUPABASE_URL, SUPABASE_ANON_KEY
  // and SUPABASE_SERVICE_ROLE_KEY into every deployed function itself — so
  // pointing `secrets set` at the full file fails on the first line.
  const pushKeys = [
    `APNS_KEY_ID=${keep('APNS_KEY_ID')}`,
    `APNS_TEAM_ID=${keep('APNS_TEAM_ID')}`,
    `APNS_BUNDLE_ID=${keep('APNS_BUNDLE_ID') || 'com.tagsnap.field'}`,
    `APNS_ENVIRONMENT=${keep('APNS_ENVIRONMENT') || 'development'}`,
    `APNS_KEY_P8=${keep('APNS_KEY_P8')}`,
    `FCM_SERVICE_ACCOUNT_JSON=${keep('FCM_SERVICE_ACCOUNT_JSON')}`,
  ];

  write('supabase/.env', [
    '# Written by scripts/setup-local.mjs.',
    '# For `supabase functions serve --env-file supabase/.env` — local only.',
    '# NEVER commit this file — .gitignore already covers it.',
    `SUPABASE_URL=${apiUrl}`,
    `SUPABASE_ANON_KEY=${anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
    'ALLOWED_ORIGINS=http://localhost:5173',
    '',
    ...pushKeys,
  ]);

  write('supabase/.env.secrets', [
    '# Written by scripts/setup-local.mjs.',
    '# For `supabase secrets set --env-file supabase/.env.secrets`.',
    '#',
    '# The SUPABASE_* keys are deliberately absent: the platform injects those',
    '# into every deployed function itself, and refuses to accept them here.',
    '# NEVER commit this file — .gitignore already covers it.',
    'ALLOWED_ORIGINS=http://localhost:5173',
    '',
    '# Optional. Without these the apps still work; the office just cannot buzz',
    '# a driver when a ticket is sent back. Both are free. See the app READMEs.',
    ...pushKeys,
  ]);

  console.log('');
  console.log(`  Mode           ${mode === 'hosted' ? 'HOSTED (no Docker)' : 'LOCAL (Docker)'}`);
  console.log(`  API            ${apiUrl}`);
  if (mode === 'local') {
    console.log(`  For the phone  ${mobileUrl}${lan ? '' : '   (no LAN address found)'}`);
  }
  console.log('');

  console.log('  Reading tickets runs on the phone and costs nothing.');
  console.log('  There is no AI key to set. See docs/OCR.md.');
  console.log('');

  console.log('  Next:');
  if (mode === 'hosted') {
    console.log('    1. npx supabase link --project-ref <your-ref>');
    console.log('    2. npx supabase db push          create the tables');
    console.log('    3. npx supabase functions deploy sign-image push-rescan');
    console.log('    4. npx supabase secrets set --env-file supabase/.env.secrets');
    console.log('    5. npm run web                   the office console');
    console.log('    6. open the app in Xcode or Android Studio');
  } else {
    console.log('    1. npm run functions     serve the edge functions');
    console.log('    2. npm run web           the office console');
    console.log('    3. open the app in Xcode or Android Studio');
  }
  console.log('');
  console.log('  One page for all of it: docs/START-HERE.md');
  console.log('');
}

/** Hosted credentials supplied through the environment. */
function hostedFromEnv() {
  const apiUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!apiUrl || !anonKey) return null;
  if (apiUrl.includes('127.0.0.1') || apiUrl.includes('localhost')) return null;

  // The service role key is optional, and asking for it up front was wrong.
  //
  // It is written into supabase/.env, which exists for
  // `supabase functions serve --env-file` — running the edge functions on your
  // own machine, which needs Docker. Every *deployed* function gets
  // SUPABASE_SERVICE_ROLE_KEY injected by the platform itself.
  //
  // So a hosted setup does not need it, and a key that bypasses every RLS
  // policy should not be copied around until something actually requires it.
  // `npm run db:config` is the one thing that does, and only when you get to
  // push notifications.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  return { apiUrl, anonKey, serviceKey, mode: 'hosted' };
}

/** Keys from a running local stack. */
function localFromCli() {
  let raw;
  try {
    raw = execSync('npx supabase status -o env', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Not running, not installed, or Docker is down. The caller prints the
    // full explanation — no point guessing which of the three it was.
    return null;
  }

  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) out[m[1]] = m[2];
  }

  if (!out.API_URL || !out.ANON_KEY || !out.SERVICE_ROLE_KEY) return null;

  return {
    apiUrl: out.API_URL,
    anonKey: out.ANON_KEY,
    serviceKey: out.SERVICE_ROLE_KEY,
    mode: 'local',
  };
}

/**
 * The first non-internal IPv4 address.
 *
 * Guessing wrong on a machine with several adapters is possible — a VPN or a
 * Docker bridge can win. If the phone cannot connect, this is the line to
 * check, which is why the address is printed rather than used silently.
 */
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const virtual = /^(vEthernet|docker|br-|veth|VirtualBox|VMware|utun|tun|WSL)/i.test(name);
      candidates.push({ address: a.address, virtual });
    }
  }
  candidates.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return candidates[0]?.address ?? null;
}

function existingValue(relative, key) {
  const path = join(root, relative);
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^${key}=(.*)$`));
    if (m) return m[1].trim();
  }
  return null;
}

function write(relative, lines) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  console.log(`  wrote ${relative}`);
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

main();
