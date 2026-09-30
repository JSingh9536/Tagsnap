import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import { AppState } from 'react-native';
import { supabase } from '../lib/supabase';
import { fetchMyProfile } from '../lib/api';
import { clearCache } from '../lib/db';
import { unregisterPush } from '../lib/notifications';
import { portalForRole, ROLE_LABEL, type Profile } from '@tagsnap/shared';

/**
 * Which door the user came in through.
 *
 * The portal is a UI affordance, not a permission. The server decides what
 * someone actually is — `profiles.role`, enforced by RLS — and this only
 * decides which sign-in screen they saw and which app they get afterwards.
 *
 * Keeping those two separate is the whole point. If the portal granted the
 * role, picking "Office" on the sign-in screen would be a privilege
 * escalation. Instead we sign in, ask the server who this is, and if the
 * answer disagrees with the door they picked we say so plainly and send them
 * to the right one.
 */
export type Portal = 'driver' | 'subhauler';

interface AuthState {
  loading: boolean;
  profile: Profile | null;
  portal: Portal | null;
  /** Set when someone signs into the wrong portal. */
  portalMismatch: { chose: Portal; actual: Profile['role'] } | null;
  locked: boolean;
}

interface AuthApi extends AuthState {
  choosePortal: (portal: Portal) => void;
  clearPortal: () => void;
  signIn: (email: string, password: string, portal: Portal) => Promise<void>;
  signInWithPhone: (phone: string) => Promise<void>;
  verifyPhone: (phone: string, code: string, portal: Portal) => Promise<void>;
  signOut: () => Promise<void>;
  unlock: () => Promise<boolean>;
  /** Re-confirms identity before an action that puts a number on an invoice. */
  confirmIdentity: (prompt: string) => Promise<boolean>;
}

const Ctx = createContext<AuthApi | null>(null);

/** How long the app may sit in the background before it locks itself. */
const LOCK_AFTER_MS = 5 * 60 * 1000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    loading: true,
    profile: null,
    portal: null,
    portalMismatch: null,
    locked: false,
  });

  const backgroundedAt = useRef<number | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      const profile = await fetchMyProfile();
      setState((s) => ({ ...s, profile, loading: false }));
    } catch {
      // A session that cannot load a profile is a session for a deactivated or
      // half-provisioned user. Treat it as signed out rather than showing an
      // app with no data in it.
      await supabase.auth.signOut();
      setState((s) => ({ ...s, profile: null, loading: false }));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        await loadProfile();
      } else {
        setState((s) => ({ ...s, loading: false }));
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setState({
          loading: false,
          profile: null,
          portal: null,
          portalMismatch: null,
          locked: false,
        });
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  // Lock on return from background. A phone left on a truck seat with the app
  // open is threat #2 in the security doc, and this is the cheap half of the
  // answer to it.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current = Date.now();
        return;
      }
      if (next === 'active' && backgroundedAt.current !== null) {
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (away > LOCK_AFTER_MS) {
          setState((s) => (s.profile ? { ...s, locked: true } : s));
        }
      }
    });
    return () => sub.remove();
  }, []);

  const choosePortal = useCallback((portal: Portal) => {
    setState((s) => ({ ...s, portal, portalMismatch: null }));
  }, []);

  const clearPortal = useCallback(() => {
    setState((s) => ({ ...s, portal: null, portalMismatch: null }));
  }, []);

  /**
   * Confirm the server agrees with the door they picked.
   *
   * Office and admin accounts are turned away here on purpose: they belong on
   * the web console, which has the review screen and the wide layout the job
   * needs. Letting them in would give them an app that cannot do their work.
   */
  const reconcilePortal = useCallback(
    async (chose: Portal) => {
      const profile = await fetchMyProfile();
      const actual = portalForRole(profile.role);

      if (actual !== chose) {
        await supabase.auth.signOut();
        setState((s) => ({
          ...s,
          profile: null,
          loading: false,
          portalMismatch: { chose, actual: profile.role },
        }));
        return;
      }

      setState((s) => ({
        ...s,
        profile,
        portal: chose,
        portalMismatch: null,
        loading: false,
        locked: false,
      }));
    },
    []
  );

  const signIn = useCallback(
    async (email: string, password: string, portal: Portal) => {
      setState((s) => ({ ...s, loading: true, portalMismatch: null }));
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        setState((s) => ({ ...s, loading: false }));
        throw new Error(friendlyAuthError(error.message));
      }
      await reconcilePortal(portal);
    },
    [reconcilePortal]
  );

  /**
   * Phone OTP.
   *
   * The default for drivers, because a field crew has gloves on and often no
   * work email. Office accounts never come through here — they use email plus
   * mandatory MFA on the web console, since those accounts can move money.
   */
  const signInWithPhone = useCallback(async (phone: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      phone: normalizePhone(phone),
    });
    if (error) throw new Error(friendlyAuthError(error.message));
  }, []);

  const verifyPhone = useCallback(
    async (phone: string, code: string, portal: Portal) => {
      setState((s) => ({ ...s, loading: true, portalMismatch: null }));
      const { error } = await supabase.auth.verifyOtp({
        phone: normalizePhone(phone),
        token: code.trim(),
        type: 'sms',
      });
      if (error) {
        setState((s) => ({ ...s, loading: false }));
        throw new Error(friendlyAuthError(error.message));
      }
      await reconcilePortal(portal);
    },
    [reconcilePortal]
  );

  const signOut = useCallback(async () => {
    // Stop this handset receiving the next person's notifications. Shared
    // phones are normal in a yard.
    await unregisterPush();

    // The outbox deliberately survives this. Unsent tags are work the driver
    // has already done, and signing out on a shared phone must not destroy it.
    await clearCache();
    await supabase.auth.signOut();
  }, []);

  const unlock = useCallback(async () => {
    const ok = await biometricPrompt('Unlock TagSnap');
    if (ok) setState((s) => ({ ...s, locked: false }));
    return ok;
  }, []);

  const confirmIdentity = useCallback(async (prompt: string) => {
    return biometricPrompt(prompt);
  }, []);

  const api = useMemo<AuthApi>(
    () => ({
      ...state,
      choosePortal,
      clearPortal,
      signIn,
      signInWithPhone,
      verifyPhone,
      signOut,
      unlock,
      confirmIdentity,
    }),
    [
      state,
      choosePortal,
      clearPortal,
      signIn,
      signInWithPhone,
      verifyPhone,
      signOut,
      unlock,
      confirmIdentity,
    ]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/**
 * Biometrics where available, and a pass where not.
 *
 * A driver with no enrolled biometric must still be able to work — a hard
 * block here would strand someone at a quarry, which is worse than the risk it
 * would close.
 */
async function biometricPrompt(promptMessage: string): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!hasHardware || !enrolled) return true;

  const res = await LocalAuthentication.authenticateAsync({
    promptMessage,
    fallbackLabel: 'Use passcode',
    disableDeviceFallback: false,
  });
  return res.success;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/** Supabase's auth errors are accurate and unhelpful. These are neither. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) {
    return 'That email and password do not match an account.';
  }
  if (m.includes('token has expired') || m.includes('expired')) {
    return 'That code has expired. Ask for a new one.';
  }
  if (m.includes('invalid otp') || m.includes('token is invalid')) {
    return 'That code is not right. Check it and try again.';
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Too many tries. Wait a minute before trying again.';
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'No connection. Signing in needs signal — your saved tags are safe.';
  }
  return message;
}

export function describePortalMismatch(
  mismatch: NonNullable<AuthState['portalMismatch']>
): string {
  const role = ROLE_LABEL[mismatch.actual];
  if (mismatch.actual === 'office' || mismatch.actual === 'admin') {
    return (
      `That is an ${role.toLowerCase()} account. Office staff work in the web ` +
      `console, where the review screen lives — this app is for the field.`
    );
  }
  const correct = mismatch.chose === 'driver' ? 'Subhauler' : 'Driver';
  return (
    `That is a ${role.toLowerCase()} account, but you signed in under ` +
    `${mismatch.chose === 'driver' ? 'Driver' : 'Subhauler'}. ` +
    `Go back and choose ${correct}.`
  );
}
