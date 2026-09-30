import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../state/auth';
import { Banner, Button } from '../components/ui';
import { accentFor, colors, radius, space, TOUCH_MIN, type } from '../theme';

type Method = 'phone' | 'email';
type PhoneStage = 'enter' | 'code';

/**
 * Sign-in for whichever portal was picked.
 *
 * Phone OTP leads, because that is the realistic case: a driver with gloves
 * on, no work email, and a phone they already have in their hand. Email and
 * password is there for subhauler owner-operators who run a business and
 * expect one.
 */
export function SignInScreen() {
  const { portal, clearPortal, signIn, signInWithPhone, verifyPhone, loading } =
    useAuth();

  const [method, setMethod] = useState<Method>('phone');
  const [stage, setStage] = useState<PhoneStage>('enter');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accent = accentFor(portal);
  const portalName = portal === 'subhauler' ? 'Subhauler' : 'Driver';

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      if (phone.replace(/\D/g, '').length < 10) {
        throw new Error('Enter a 10-digit mobile number.');
      }
      await signInWithPhone(phone);
      setStage('code');
    });

  const submitCode = () =>
    run(async () => {
      if (!portal) return;
      await verifyPhone(phone, code, portal);
    });

  const submitPassword = () =>
    run(async () => {
      if (!portal) return;
      if (!email.trim() || !password) {
        throw new Error('Enter your email and password.');
      }
      await signIn(email, password, portal);
    });

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={s.container}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable onPress={clearPortal} style={s.back} hitSlop={12}>
            <Text style={s.backText}>← Not a {portalName.toLowerCase()}?</Text>
          </Pressable>

          <View style={s.header}>
            <View style={[s.badge, { backgroundColor: accent }]}>
              <Text style={s.badgeText}>{portalName}</Text>
            </View>
            <Text style={s.title}>Sign in</Text>
          </View>

          {error ? <Banner tone="bad" title="Could not sign in" detail={error} /> : null}

          {method === 'phone' ? (
            stage === 'enter' ? (
              <View style={s.form}>
                <Text style={s.label}>Mobile number</Text>
                <TextInput
                  style={s.input}
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="(555) 555-5555"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  returnKeyType="go"
                  onSubmitEditing={sendCode}
                  editable={!busy}
                />
                <Text style={s.hint}>
                  We text you a six-digit code. No password to remember.
                </Text>
                <Button
                  title="Text me a code"
                  onPress={sendCode}
                  accent={accent}
                  loading={busy || loading}
                />
              </View>
            ) : (
              <View style={s.form}>
                <Text style={s.label}>Code sent to {phone}</Text>
                <TextInput
                  style={[s.input, s.codeInput]}
                  value={code}
                  onChangeText={setCode}
                  placeholder="000000"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  autoFocus
                  editable={!busy}
                />
                <Button
                  title="Sign in"
                  onPress={submitCode}
                  accent={accent}
                  loading={busy || loading}
                />
                <Pressable
                  onPress={() => {
                    setStage('enter');
                    setCode('');
                  }}
                  style={s.linkRow}
                >
                  <Text style={s.link}>Use a different number</Text>
                </Pressable>
              </View>
            )
          ) : (
            <View style={s.form}>
              <Text style={s.label}>Email</Text>
              <TextInput
                style={s.input}
                value={email}
                onChangeText={setEmail}
                placeholder="you@company.com"
                placeholderTextColor={colors.textFaint}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="username"
                editable={!busy}
              />
              <Text style={s.label}>Password</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submitPassword}
                editable={!busy}
              />
              <Button
                title="Sign in"
                onPress={submitPassword}
                accent={accent}
                loading={busy || loading}
              />
            </View>
          )}

          <Pressable
            onPress={() => {
              setMethod(method === 'phone' ? 'email' : 'phone');
              setStage('enter');
              setError(null);
            }}
            style={s.linkRow}
          >
            <Text style={s.link}>
              {method === 'phone'
                ? 'Use email and password instead'
                : 'Use my phone number instead'}
            </Text>
          </Pressable>

          <Text style={s.footnote}>
            No account? Your office sets one up — it has to be tied to the right
            payee before any load can be billed.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  container: { flexGrow: 1, padding: space.lg, gap: space.lg },

  back: { minHeight: 40, justifyContent: 'center' },
  backText: { ...type.small, color: colors.textMuted },

  header: { gap: space.sm },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  badgeText: { ...type.label, color: colors.onAccent },
  title: { ...type.display, color: colors.text },

  form: { gap: space.sm },
  label: { ...type.label, color: colors.textFaint, marginTop: space.sm },
  input: {
    minHeight: TOUCH_MIN,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: 19,
  },
  codeInput: { fontSize: 30, letterSpacing: 10, textAlign: 'center' },
  hint: { ...type.small, color: colors.textMuted, lineHeight: 21 },

  linkRow: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  link: { ...type.small, color: colors.textMuted, textDecorationLine: 'underline' },

  footnote: {
    ...type.small,
    color: colors.textFaint,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 'auto',
  },
});
