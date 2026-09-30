import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, radius, space, TOUCH_MIN, toneColor, type } from '../theme';
import type { StatusTone } from '@tagsnap/shared';

export function Screen({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[s.screen, style]}>{children}</View>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={s.heading}>{children}</Text>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={s.title}>{children}</Text>;
}

export function Body({
  children,
  muted,
  style,
}: {
  children: React.ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[s.body, muted && { color: colors.textMuted }, style]}>
      {children}
    </Text>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  accent = colors.driver,
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  accent?: string;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';

  const bg = isDanger ? colors.bad : isPrimary ? accent : 'transparent';
  const fg = isDanger
    ? '#fff'
    : isPrimary
      ? colors.onAccent
      : variant === 'ghost'
        ? colors.textMuted
        : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg },
        variant === 'secondary' && s.buttonOutlined,
        (disabled || loading) && s.buttonDisabled,
        pressed && s.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[s.buttonText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.card, pressed && s.cardPressed, style]}
    >
      {children}
    </Pressable>
  );
}

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: StatusTone;
}) {
  const c = toneColor[tone];
  return (
    <View style={[s.pill, { borderColor: c, backgroundColor: `${c}22` }]}>
      <View style={[s.pillDot, { backgroundColor: c }]} />
      <Text style={[s.pillText, { color: c }]}>{label}</Text>
    </View>
  );
}

export function Field({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Text style={[s.fieldValue, emphasis && s.fieldValueEmphasis]}>{value}</Text>
    </View>
  );
}

/**
 * An empty state that says what to do next.
 *
 * "No tags yet" tells the driver nothing. "Photograph a ticket when you leave
 * the scale" tells them the job.
 */
export function Empty({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={s.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

export function Banner({
  tone,
  title,
  detail,
  action,
}: {
  tone: StatusTone;
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
}) {
  const c = toneColor[tone];
  return (
    <View style={[s.banner, { borderLeftColor: c, backgroundColor: `${c}18` }]}>
      <Text style={[s.bannerTitle, { color: c }]}>{title}</Text>
      {detail ? <Text style={s.bannerDetail}>{detail}</Text> : null}
      {action ? (
        <Pressable onPress={action.onPress} style={s.bannerAction}>
          <Text style={[s.bannerActionText, { color: c }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <View style={s.spinner}>
      <ActivityIndicator color={colors.textMuted} />
      {label ? <Text style={s.spinnerLabel}>{label}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { ...type.title, color: colors.text },
  heading: { ...type.heading, color: colors.text },
  body: { ...type.body, color: colors.text, lineHeight: 24 },
  label: { ...type.label, color: colors.textFaint },

  button: {
    minHeight: TOUCH_MIN,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonOutlined: { borderWidth: 1.5, borderColor: colors.border },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { ...type.bodyStrong },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
  },
  cardPressed: { backgroundColor: colors.surfaceRaised },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    gap: 6,
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 13, fontWeight: '700' },

  field: { gap: 2, minWidth: 96 },
  fieldLabel: { ...type.label, color: colors.textFaint },
  fieldValue: { ...type.body, color: colors.text },
  fieldValueEmphasis: { ...type.mono, color: colors.text, fontSize: 20 },

  empty: { alignItems: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { ...type.heading, color: colors.textMuted, textAlign: 'center' },
  emptyHint: {
    ...type.small,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 22,
  },

  banner: {
    borderLeftWidth: 4,
    borderRadius: radius.sm,
    padding: space.md,
    gap: space.xs,
  },
  bannerTitle: { ...type.bodyStrong },
  bannerDetail: { ...type.small, color: colors.text, lineHeight: 21 },
  bannerAction: { paddingTop: space.sm, minHeight: 32 },
  bannerActionText: { ...type.bodyStrong },

  spinner: { padding: space.xl, alignItems: 'center', gap: space.sm },
  spinnerLabel: { ...type.small, color: colors.textMuted },
});
