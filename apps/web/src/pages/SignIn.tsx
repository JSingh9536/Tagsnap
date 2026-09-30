import React, { useState } from 'react';
import { useAuth } from '../state/auth';

/**
 * Office sign-in.
 *
 * Email and password plus mandatory TOTP. These accounts approve payments, so
 * a second factor is not a preference — a compromised office password with no
 * MFA is a compromised accounts-payable system.
 */
export function SignIn() {
  const { signIn, verifyMfa, mfaRequired, wrongRole, loading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <form
        className="signin__card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            mfaRequired ? verifyMfa(code) : signIn(email, password)
          );
        }}
      >
        <h1>TagSnap Office</h1>
        <p className="muted">Review, correct, and approve scale tickets.</p>

        {wrongRole ? <p className="alert alert--attention">{wrongRole}</p> : null}
        {error ? <p className="alert alert--bad">{error}</p> : null}

        {mfaRequired ? (
          <>
            <label className="field">
              <span className="fieldlabel">Code from your authenticator</span>
              <input
                className="codeinput"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                autoFocus
              />
            </label>
            <button className="btn btn--primary" disabled={busy || loading}>
              {busy ? 'Checking…' : 'Verify'}
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span className="fieldlabel">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="field">
              <span className="fieldlabel">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button className="btn btn--primary" disabled={busy || loading}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        )}

        <p className="footnote">
          Drivers and subhaulers use the TagSnap app on their phone, not this
          console.
        </p>
      </form>
    </main>
  );
}
