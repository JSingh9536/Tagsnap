import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { supabase } from '../lib/supabase';
import type { Profile } from '@tagsnap/shared';

/**
 * Office authentication.
 *
 * Two things separate this from the mobile app's sign-in:
 *
 *   - only `office` and `admin` get in. A driver with a valid token is turned
 *     away at the door here, and RLS would stop them at every query anyway.
 *   - MFA is mandatory. These accounts approve payments, which is the whole
 *     reason the role exists, so a second factor is not optional.
 */

interface State {
  loading: boolean;
  profile: Profile | null;
  /** Set when a signed-in account has not finished its MFA challenge. */
  mfaRequired: boolean;
  wrongRole: string | null;
}

interface Api extends State {
  signIn: (email: string, password: string) => Promise<void>;
  verifyMfa: (code: string) => Promise<void>;
  enrollMfa: () => Promise<{ qr: string; secret: string; factorId: string }>;
  confirmEnrollment: (factorId: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Api | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({
    loading: true,
    profile: null,
    mfaRequired: false,
    wrongRole: null,
  });

  const load = useCallback(async () => {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) {
      setState((s) => ({ ...s, loading: false, profile: null }));
      return;
    }

    // aal1 means signed in but not MFA-verified. Everything past this point
    // can approve a payment, so aal1 is not enough.
    const { data: aal } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      setState((s) => ({ ...s, loading: false, mfaRequired: true }));
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.session.user.id)
      .single();

    if (!profile || !profile.active) {
      await supabase.auth.signOut();
      setState({
        loading: false,
        profile: null,
        mfaRequired: false,
        wrongRole: 'This account is not active.',
      });
      return;
    }

    if (profile.role !== 'office' && profile.role !== 'admin') {
      await supabase.auth.signOut();
      setState({
        loading: false,
        profile: null,
        mfaRequired: false,
        wrongRole:
          'This console is for office staff. Drivers and subhaulers use the TagSnap app on their phone.',
      });
      return;
    }

    setState({
      loading: false,
      profile: profile as Profile,
      mfaRequired: false,
      wrongRole: null,
    });
  }, []);

  useEffect(() => {
    void load();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setState({
          loading: false,
          profile: null,
          mfaRequired: false,
          wrongRole: null,
        });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setState((s) => ({ ...s, loading: true, wrongRole: null }));
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        setState((s) => ({ ...s, loading: false }));
        throw new Error(
          error.message.toLowerCase().includes('invalid login credentials')
            ? 'That email and password do not match an account.'
            : error.message
        );
      }
      await load();
    },
    [load]
  );

  const verifyMfa = useCallback(
    async (code: string) => {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp?.[0];
      if (!factor) throw new Error('No authenticator is set up on this account.');

      const { data: challenge, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (challengeError || !challenge) {
        throw new Error(challengeError?.message ?? 'Could not start the check.');
      }

      const { error } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (error) throw new Error('That code is not right. Check the app and try again.');

      await load();
    },
    [load]
  );

  const enrollMfa = useCallback(async () => {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'TagSnap Office',
    });
    if (error || !data) throw new Error(error?.message ?? 'Could not start setup.');
    return {
      qr: data.totp.qr_code,
      secret: data.totp.secret,
      factorId: data.id,
    };
  }, []);

  const confirmEnrollment = useCallback(
    async (factorId: string, code: string) => {
      const { data: challenge, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });
      if (challengeError || !challenge) {
        throw new Error(challengeError?.message ?? 'Could not start the check.');
      }
      const { error } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (error) throw new Error('That code is not right.');
      await load();
    },
    [load]
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const api = useMemo<Api>(
    () => ({ ...state, signIn, verifyMfa, enrollMfa, confirmEnrollment, signOut }),
    [state, signIn, verifyMfa, enrollMfa, confirmEnrollment, signOut]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAuth(): Api {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
