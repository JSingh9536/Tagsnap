import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../state/auth';
import { useTags } from '../state/tags';
import { Button, Card } from '../components/ui';
import { accentFor, colors, radius, space, type } from '../theme';
import { PAYEE_LEDGER_LABEL, ROLE_LABEL, payeeForRole } from '@tagsnap/shared';

export function AccountScreen() {
  const { profile, portal, signOut } = useAuth();
  const { outbox, online, syncing, lastSyncedAt, kickSync } = useTags();

  const accent = accentFor(portal);
  const unsent = outbox.filter((o) => o.state !== 'sent').length;

  if (!profile) return <SafeAreaView style={s.safe} />;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.identity}>
          <View style={[s.avatar, { backgroundColor: accent }]}>
            <Text style={s.initials}>{initials(profile.full_name)}</Text>
          </View>
          <Text style={s.name}>{profile.full_name}</Text>
          <View style={[s.roleBadge, { borderColor: accent }]}>
            <Text style={[s.roleText, { color: accent }]}>
              {ROLE_LABEL[profile.role]}
            </Text>
          </View>
        </View>

        <Card style={s.card}>
          <Row label="Paid as" value={PAYEE_LEDGER_LABEL[payeeForRole(profile.role)]} />
          {profile.phone ? <Row label="Phone" value={profile.phone} /> : null}
          {profile.email ? <Row label="Email" value={profile.email} /> : null}
        </Card>

        <Card style={s.card}>
          <Text style={s.cardTitle}>This phone</Text>
          <Row label="Signal" value={online ? 'Connected' : 'No signal'} />
          <Row
            label="Waiting to send"
            value={unsent === 0 ? 'Nothing' : `${unsent} ${unsent === 1 ? 'ticket' : 'tickets'}`}
          />
          <Row
            label="Last sent"
            value={lastSyncedAt ? lastSyncedAt.toLocaleTimeString() : 'Not yet'}
          />
          {unsent > 0 ? (
            <Button
              title="Try sending now"
              variant="secondary"
              onPress={() => void kickSync()}
              loading={syncing}
              style={s.syncButton}
            />
          ) : null}
        </Card>

        <Text style={s.privacy}>
          TagSnap records where a photo was taken, at the moment you take it, so
          the office can confirm the quarry without calling you. It never tracks
          you in the background.
        </Text>

        <Button
          title="Sign out"
          variant="secondary"
          onPress={() => void signOut()}
          style={s.signOut}
        />

        {unsent > 0 ? (
          <Text style={s.signOutNote}>
            Signing out keeps the {unsent} unsent{' '}
            {unsent === 1 ? 'ticket' : 'tickets'} on this phone. They send when
            you sign back in.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: space.md, gap: space.md, paddingBottom: space.xxl },

  identity: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  avatar: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  initials: { ...type.title, color: colors.onAccent },
  name: { ...type.title, color: colors.text },
  roleBadge: {
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  roleText: { ...type.label },

  card: { gap: space.sm },
  cardTitle: { ...type.label, color: colors.textFaint },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  rowLabel: { ...type.small, color: colors.textMuted },
  rowValue: { ...type.small, color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  syncButton: { marginTop: space.sm },

  privacy: { ...type.small, color: colors.textFaint, lineHeight: 21, paddingHorizontal: space.xs },
  signOut: { marginTop: space.sm },
  signOutNote: { ...type.small, color: colors.textFaint, textAlign: 'center', lineHeight: 20 },
});
