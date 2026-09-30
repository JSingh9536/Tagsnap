/**
 * Push delivery, straight to Apple and Google.
 *
 * The Expo prototype posted to exp.host and let Expo fan out to APNs and FCM.
 * Native builds do not have that intermediary, so this talks to both providers
 * directly. Both are free at any volume this system will ever reach — the only
 * cost is the Apple Developer Program membership you already need to ship an
 * iOS app at all.
 *
 * Two credentials, and nothing else:
 *
 *   APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID
 *     A .p8 auth key from developer.apple.com. One key works for every app on
 *     the team, for both sandbox and production, and never expires. This is
 *     token-based auth — there is no certificate to renew every year.
 *
 *   FCM_SERVICE_ACCOUNT_JSON
 *     A Firebase service account, used only to mint an access token for the
 *     FCM v1 send endpoint. Android needs Firebase because FCM is the only
 *     delivery path to a Play-services device; iOS does not, which is why
 *     there is no Firebase SDK anywhere in the iOS app.
 *
 * Both JWTs are cached until shortly before they expire. Apple rate-limits
 * clients that mint a fresh token per push, and Google's token endpoint is a
 * round trip you do not want in the path of a rescan.
 */

export type Platform = 'ios' | 'android';

export interface PushMessage {
  title: string;
  body: string;
  /** Merged into the payload so a tap can open the right screen. */
  data: Record<string, string>;
  /** High is for the rescan — somebody in the office is blocked on it. */
  priority: 'high' | 'normal';
  /** Android notification channel. Created by the app at first launch. */
  channelId: string;
}

export interface PushOutcome {
  token: string;
  ok: boolean;
  /** True when the provider says this device is gone for good. */
  retire: boolean;
  detail?: string;
}

// ------------------------------------------------------------------ Apple

const APNS_KEY_P8 = Deno.env.get('APNS_KEY_P8') ?? '';
const APNS_KEY_ID = Deno.env.get('APNS_KEY_ID') ?? '';
const APNS_TEAM_ID = Deno.env.get('APNS_TEAM_ID') ?? '';
const APNS_BUNDLE_ID = Deno.env.get('APNS_BUNDLE_ID') ?? '';

/**
 * Sandbox tokens come from Xcode builds and TestFlight-adjacent development
 * installs; production tokens come from TestFlight and the App Store. A token
 * from one environment is rejected by the other, which is the single most
 * common reason "push works on my machine and not on the tester's phone".
 */
const APNS_HOST =
  (Deno.env.get('APNS_ENVIRONMENT') ?? 'production') === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';

let apnsJwt: { token: string; mintedAt: number } | null = null;

/** Apple rejects tokens older than an hour and rate-limits frequent minting. */
const APNS_JWT_TTL_MS = 45 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBody(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function appleToken(): Promise<string> {
  if (apnsJwt && Date.now() - apnsJwt.mintedAt < APNS_JWT_TTL_MS) {
    return apnsJwt.token;
  }
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID) {
    throw new Error('APNs is not configured');
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(APNS_KEY_P8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const header = base64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID })
    )
  );
  const claims = base64url(
    new TextEncoder().encode(
      JSON.stringify({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })
    )
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  );

  const token = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
  apnsJwt = { token, mintedAt: Date.now() };
  return token;
}

async function sendApns(
  deviceToken: string,
  message: PushMessage
): Promise<PushOutcome> {
  const jwt = await appleToken();

  const payload = {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: 'default',
      badge: 1,
      // A rescan is exactly what Apple means by time-sensitive: somebody is
      // waiting on this person, and it should break through a Focus mode.
      'interruption-level':
        message.priority === 'high' ? 'time-sensitive' : 'active',
    },
    ...message.data,
  };

  const res = await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': message.priority === 'high' ? '10' : '5',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (res.ok) return { token: deviceToken, ok: true, retire: false };

  const detail = await res.text().catch(() => '');

  // 410 means the app was uninstalled. 400 BadDeviceToken means the token was
  // minted against the other environment or belongs to another app. Both are
  // permanent for this token, so it gets retired rather than retried forever.
  const retire =
    res.status === 410 ||
    (res.status === 400 && detail.includes('BadDeviceToken'));

  return { token: deviceToken, ok: false, retire, detail };
}

// ----------------------------------------------------------------- Google

const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') ?? '';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

let googleAccess: { token: string; expiresAt: number } | null = null;

function serviceAccount(): ServiceAccount {
  if (!FCM_SERVICE_ACCOUNT_JSON) throw new Error('FCM is not configured');
  return JSON.parse(FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
}

async function googleToken(): Promise<{ token: string; projectId: string }> {
  const sa = serviceAccount();

  if (googleAccess && Date.now() < googleAccess.expiresAt - 60_000) {
    return { token: googleAccess.token, projectId: sa.project_id };
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  );
  const claims = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    )
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  );
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    throw new Error(`google token exchange failed (${res.status})`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  googleAccess = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };

  return { token: body.access_token, projectId: sa.project_id };
}

async function sendFcm(
  deviceToken: string,
  message: PushMessage
): Promise<PushOutcome> {
  const { token: access, projectId } = await googleToken();

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: message.title, body: message.body },
          android: {
            priority: message.priority === 'high' ? 'HIGH' : 'NORMAL',
            notification: {
              channel_id: message.channelId,
              sound: 'default',
            },
          },
          data: message.data,
        },
      }),
    }
  );

  if (res.ok) return { token: deviceToken, ok: true, retire: false };

  const detail = await res.text().catch(() => '');

  // UNREGISTERED is the app being uninstalled; INVALID_ARGUMENT on the token
  // field is a malformed or foreign token. Neither will ever start working.
  const retire =
    res.status === 404 ||
    detail.includes('UNREGISTERED') ||
    (res.status === 400 && detail.includes('INVALID_ARGUMENT'));

  return { token: deviceToken, ok: false, retire, detail };
}

// ------------------------------------------------------------------ facade

/**
 * Deliver one message to a set of devices.
 *
 * Never throws. A notification that fails to send must not look like a rescan
 * request that failed to save — the request is already in the database, and
 * this is the doorbell, not the door.
 */
export async function deliver(
  devices: { token: string; platform: string | null }[],
  message: PushMessage
): Promise<PushOutcome[]> {
  return await Promise.all(
    devices.map(async (d) => {
      try {
        return d.platform === 'ios'
          ? await sendApns(d.token, message)
          : await sendFcm(d.token, message);
      } catch (err) {
        return {
          token: d.token,
          ok: false,
          // A configuration or network failure is transient. Retiring a token
          // over one would silently unsubscribe a working phone.
          retire: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}
