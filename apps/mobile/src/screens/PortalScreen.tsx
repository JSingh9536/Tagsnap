import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth, describePortalMismatch, type Portal } from '../state/auth';
import { Banner } from '../components/ui';
import { colors, radius, space, type } from '../theme';

/**
 * The first screen. Driver or subhauler.
 *
 * This exists because the two are paid out of different books. An employee
 * driver's loads land on a settlement; a subhauler's land on an accounts
 * payable invoice to their outfit. Asking up front means every screen after
 * this one knows which book it is working in, and a subhauler running for two
 * outfits never has to wonder which account they are logged into.
 *
 * What it is not: a permission. The server decides what someone is. Choosing
 * "Subhauler" here gets you a subhauler-shaped sign-in screen, not subhauler
 * access — see reconcilePortal in state/auth.tsx.
 */
export function PortalScreen() {
  const { choosePortal, portalMismatch } = useAuth();

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.brand}>
          <Text style={s.wordmark}>TagSnap</Text>
          <Text style={s.tagline}>
            Photograph the ticket. The office does the rest.
          </Text>
        </View>

        {portalMismatch ? (
          <Banner
            tone="attention"
            title="Wrong sign-in for that account"
            detail={describePortalMismatch(portalMismatch)}
          />
        ) : null}

        <View style={s.choices}>
          <PortalCard
            portal="driver"
            title="Driver"
            subtitle="Company truck"
            detail="Your loads go on your driver settlement."
            accent={colors.driver}
            onPress={() => choosePortal('driver')}
          />
          <PortalCard
            portal="subhauler"
            title="Subhauler"
            subtitle="Outside outfit"
            detail="Your loads are billed from your company to ours."
            accent={colors.subhauler}
            onPress={() => choosePortal('subhauler')}
          />
        </View>

        <Text style={s.footnote}>
          Office staff review and approve tags in the web console, not here.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function PortalCard({
  portal,
  title,
  subtitle,
  detail,
  accent,
  onPress,
}: {
  portal: Portal;
  title: string;
  subtitle: string;
  detail: string;
  accent: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sign in as ${title}. ${detail}`}
      onPress={onPress}
      testID={`portal-${portal}`}
      style={({ pressed }) => [
        s.card,
        { borderColor: accent },
        pressed && { backgroundColor: `${accent}1A` },
      ]}
    >
      <View style={[s.stripe, { backgroundColor: accent }]} />
      <View style={s.cardBody}>
        <Text style={[s.cardTitle, { color: accent }]}>{title}</Text>
        <Text style={s.cardSubtitle}>{subtitle}</Text>
        <Text style={s.cardDetail}>{detail}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: {
    flexGrow: 1,
    padding: space.lg,
    gap: space.lg,
    justifyContent: 'center',
  },
  brand: { gap: space.sm, marginBottom: space.md },
  wordmark: { ...type.display, color: colors.text },
  tagline: { ...type.body, color: colors.textMuted, lineHeight: 24 },

  choices: { gap: space.md },
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    overflow: 'hidden',
    minHeight: 132,
  },
  stripe: { width: 6 },
  cardBody: { flex: 1, padding: space.md, gap: space.xs, justifyContent: 'center' },
  cardTitle: { ...type.title },
  cardSubtitle: { ...type.label, color: colors.textFaint },
  cardDetail: { ...type.small, color: colors.textMuted, lineHeight: 21 },

  footnote: {
    ...type.small,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 21,
  },
});
