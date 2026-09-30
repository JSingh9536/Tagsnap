import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../state/auth';
import { Button } from '../components/ui';
import { accentFor, colors, space, type } from '../theme';

/**
 * Shown when the app has been in the background long enough to lock.
 *
 * A phone left face-up on a truck seat with a live session is threat #2 in the
 * security doc. This is the cheap half of the answer — the expensive half is
 * the server-side session limits, which do not depend on this screen existing.
 */
export function LockScreen() {
  const { unlock, signOut, portal, profile } = useAuth();
  const [failed, setFailed] = useState(false);
  const accent = accentFor(portal);

  const attempt = async () => {
    const ok = await unlock();
    setFailed(!ok);
  };

  // Prompt straight away rather than making someone tap twice to get back to
  // work they were already in the middle of.
  useEffect(() => {
    void attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.body}>
        <Text style={s.wordmark}>TagSnap</Text>
        <Text style={s.locked}>Locked</Text>
        {profile ? <Text style={s.who}>{profile.full_name}</Text> : null}

        {failed ? (
          <Text style={s.failed}>
            That did not unlock it. Try again, or sign out and back in.
          </Text>
        ) : null}

        <Button title="Unlock" accent={accent} onPress={attempt} style={s.button} />
        <Button
          title="Sign out"
          variant="ghost"
          onPress={() => void signOut()}
          style={s.button}
        />

        <Text style={s.note}>
          Anything you photographed is saved on this phone and is not lost.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, justifyContent: 'center', padding: space.lg, gap: space.sm },
  wordmark: { ...type.display, color: colors.text, textAlign: 'center' },
  locked: { ...type.body, color: colors.textMuted, textAlign: 'center' },
  who: { ...type.small, color: colors.textFaint, textAlign: 'center', marginBottom: space.md },
  failed: { ...type.small, color: colors.bad, textAlign: 'center', lineHeight: 21 },
  button: { marginTop: space.sm },
  note: {
    ...type.small,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: space.lg,
    lineHeight: 21,
  },
});
